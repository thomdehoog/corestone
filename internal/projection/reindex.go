package projection

import (
	"context"
	"database/sql"
	"fmt"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

const batchSize = 200

// Reindex rebuilds every projection table from the repository head in the
// phases of design guide §10.3: identity → fields → full text → history.
func (p *DB) Reindex(ctx context.Context) error {
	p.syncMu.Lock()
	defer p.syncMu.Unlock()
	return p.rebuildLocked(ctx, "requested")
}

type item struct {
	entry gitx.TreeEntry
	match scanner.Match
}

func (p *DB) rebuildLocked(ctx context.Context, reason string) (err error) {
	if !p.EnterMaintenance("reindex: " + reason) {
		return fmt.Errorf("%w: %s", model.ErrMaintenance, p.Status().Reason)
	}
	defer p.LeaveMaintenance()
	p.setStatus(func(s *Status) { s.Capabilities = Capabilities{}; s.LastError = "" })
	defer func() {
		if err != nil {
			p.setStatus(func(s *Status) { s.LastError = err.Error() })
			return
		}
		done := time.Now().UTC()
		p.setStatus(func(s *Status) { s.LastRebuild = &done })
	}()

	head, err := p.repo.Head(ctx)
	if err != nil {
		return err
	}
	if err := p.loadScanner(ctx, head); err != nil {
		return err
	}
	sc := p.Scanner()
	entries, err := p.repo.ListTree(ctx, head)
	if err != nil {
		return err
	}
	var artifacts, attachments, configs []item
	for _, e := range entries {
		m, ok := sc.Match(e.Path)
		if !ok {
			continue
		}
		it := item{e, m}
		switch m.Category {
		case scanner.Artifact:
			artifacts = append(artifacts, it)
		case scanner.Attachment:
			attachments = append(attachments, it)
		case scanner.ConfigFile:
			if m.ConfigKind == scanner.ConfigLinks || m.ConfigKind == scanner.ConfigComments {
				artifacts = append(artifacts, it)
			} else {
				configs = append(configs, it)
			}
		}
	}

	// Phase 1: GUID recognition — identity rows only.
	p.setStatus(func(s *Status) { s.Phase = "identity"; s.Progress = 0; s.Total = len(artifacts) })
	if err := p.phaseIdentity(ctx, artifacts, attachments, configs); err != nil {
		return err
	}
	p.setStatus(func(s *Status) { s.Capabilities.Lookup = true })

	// Phase 2: field indexing — parse every artifact and configuration file.
	p.setStatus(func(s *Status) { s.Phase = "fields"; s.Progress = 0; s.Total = len(artifacts) + len(configs) })
	if err := p.phaseFields(ctx, artifacts, configs); err != nil {
		return err
	}
	p.setStatus(func(s *Status) { s.Capabilities.Query = true })

	// Phase 3: full-text — drop the index, stream text with workers, recreate.
	p.setStatus(func(s *Status) { s.Phase = "fulltext"; s.Progress = 0; s.Total = len(artifacts) })
	if err := p.phaseFullText(ctx, artifacts); err != nil {
		return err
	}
	p.setStatus(func(s *Status) { s.Capabilities.Search = true })

	// Phase 4: history scan — deletions, HID history, timestamps.
	p.setStatus(func(s *Status) { s.Phase = "history"; s.Progress = 0; s.Total = 0 })
	if err := p.phaseHistory(ctx, head); err != nil {
		return err
	}

	if _, err := p.sql.ExecContext(ctx, `UPDATE repo_state SET processed_hash = $1, updated_at = now() WHERE id = 1`, head); err != nil {
		return unavailable(err)
	}
	p.invalidateCache()
	p.setStatus(func(s *Status) { s.ProcessedHash = head; s.Phase = "done" })
	return nil
}

func (p *DB) phaseIdentity(ctx context.Context, artifacts, attachments, configs []item) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return unavailable(err)
	}
	defer tx.Rollback()
	// A crash from here on must force a rebuild, never an incremental replay
	// onto half-built tables.
	for _, stmt := range []string{
		`UPDATE repo_state SET processed_hash = '' WHERE id = 1`,
		`TRUNCATE artifact_fields, artifacts, artifact_files, config_files, hid_history, deleted_artifacts, file_issues`,
	} {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return unavailable(err)
		}
	}
	for i, it := range artifacts {
		guid, kind := it.match.GUID, model.KindEntry
		if it.match.Category == scanner.ConfigFile {
			guid = it.match.Name
			kind, _ = scanner.KindOf(it.match.ConfigKind)
		}
		if !model.IsGUID(guid) {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifacts (guid, kind, folder, path, file_path, blob_sha, valid, error)
			VALUES ($1,$2,$3,$4::ltree,$5,$6,false,'not yet indexed') ON CONFLICT (guid) DO NOTHING`,
			guid, string(kind), it.match.Folder, PathOf(it.match.Folder), it.entry.Path, it.entry.SHA); err != nil {
			return unavailable(err)
		}
		if i%batchSize == 0 {
			p.setStatus(func(s *Status) { s.Progress = i })
		}
	}
	for _, it := range attachments {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_files (guid, name, path, blob_sha, size) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
			it.match.GUID, it.match.Name, it.entry.Path, it.entry.SHA, it.entry.Size); err != nil {
			return unavailable(err)
		}
	}
	for _, it := range configs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO config_files (path, scope, scope_path, category, name, blob_sha, valid, error)
			VALUES ($1,$2,$3::ltree,$4,$5,$6,false,'not yet indexed') ON CONFLICT DO NOTHING`,
			it.entry.Path, it.match.Folder, PathOf(it.match.Folder), it.match.ConfigKind, it.match.Name, it.entry.SHA); err != nil {
			return unavailable(err)
		}
	}
	return unavailable(tx.Commit())
}

func (p *DB) phaseFields(ctx context.Context, artifacts, configs []item) error {
	done := 0
	for start := 0; start < len(artifacts); start += batchSize {
		end := min(start+batchSize, len(artifacts))
		batch := artifacts[start:end]
		shas := make([]string, 0, len(batch))
		for _, it := range batch {
			shas = append(shas, it.entry.SHA)
		}
		blobs, err := p.repo.ReadBlobs(ctx, shas)
		if err != nil {
			return err
		}
		tx, err := p.Begin(ctx)
		if err != nil {
			return unavailable(err)
		}
		for _, it := range batch {
			rec := extract(it.match, it.entry.SHA, blobs[it.entry.SHA])
			rec.Search = "" // filled by the full-text phase
			locGUID := it.match.GUID
			if it.match.Category == scanner.ConfigFile {
				locGUID = it.match.Name
			}
			if rec.GUID == "" {
				continue
			}
			if rec.GUID != locGUID {
				if _, err := tx.ExecContext(ctx, `DELETE FROM artifacts WHERE guid = $1`, locGUID); err != nil {
					tx.Rollback()
					return unavailable(err)
				}
			}
			if err := p.upsertRecord(ctx, tx, rec, "", time.Time{}, nil); err != nil {
				tx.Rollback()
				return err
			}
			// upsertRecord seeds hid_history with an unknown "since"; the
			// history phase fills in the real commit.
		}
		if err := tx.Commit(); err != nil {
			return unavailable(err)
		}
		done = end
		p.setStatus(func(s *Status) { s.Progress = done })
	}
	if len(configs) > 0 {
		shas := make([]string, 0, len(configs))
		for _, it := range configs {
			shas = append(shas, it.entry.SHA)
		}
		blobs, err := p.repo.ReadBlobs(ctx, shas)
		if err != nil {
			return err
		}
		tx, err := p.Begin(ctx)
		if err != nil {
			return unavailable(err)
		}
		for _, it := range configs {
			if err := p.upsertConfig(ctx, tx, extractConfig(it.match, it.entry.SHA, blobs[it.entry.SHA])); err != nil {
				tx.Rollback()
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return unavailable(err)
		}
	}
	p.setStatus(func(s *Status) { s.Progress = s.Total })
	return nil
}

func (p *DB) phaseFullText(ctx context.Context, artifacts []item) error {
	if _, err := p.sql.ExecContext(ctx, `DROP INDEX IF EXISTS artifacts_tsv`); err != nil {
		return unavailable(err)
	}
	workers := min(4, max(1, runtime.NumCPU()))
	jobs := make(chan []item)
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
		done     int
	)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for batch := range jobs {
				if err := p.streamText(ctx, batch); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					continue
				}
				mu.Lock()
				done += len(batch)
				n := done
				mu.Unlock()
				p.setStatus(func(s *Status) { s.Progress = n })
			}
		}()
	}
	for start := 0; start < len(artifacts); start += batchSize {
		jobs <- artifacts[start:min(start+batchSize, len(artifacts))]
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	conn, err := p.sql.Conn(ctx)
	if err != nil {
		return unavailable(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SET maintenance_work_mem = '256MB'`); err != nil {
		return unavailable(err)
	}
	if _, err := conn.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS artifacts_tsv ON artifacts USING GIN (tsv)`); err != nil {
		return unavailable(err)
	}
	return nil
}

func (p *DB) streamText(ctx context.Context, batch []item) error {
	shas := make([]string, 0, len(batch))
	for _, it := range batch {
		shas = append(shas, it.entry.SHA)
	}
	blobs, err := p.repo.ReadBlobs(ctx, shas)
	if err != nil {
		return err
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		return unavailable(err)
	}
	defer tx.Rollback()
	for _, it := range batch {
		rec := extract(it.match, it.entry.SHA, blobs[it.entry.SHA])
		if rec.GUID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE artifacts SET search_text = $1 WHERE guid = $2 AND file_path = $3`, rec.Search, rec.GUID, rec.Path); err != nil {
			return unavailable(err)
		}
	}
	return unavailable(tx.Commit())
}

// histEvent is one artifact-file change seen while walking history.
type histEvent struct {
	path, oldSHA, newSHA, commit string
	status                       byte
	at                           time.Time
	match                        scanner.Match
}

// phaseHistory walks the first-parent history once (newest first) to find
// deleted artifacts, HID changes and creation/modification times.
func (p *DB) phaseHistory(ctx context.Context, head string) error {
	sc := p.Scanner()
	// Live artifacts: identity is the GUID inside the file, which may differ
	// from the directory name after direct pushes. Paths are mapped to GUIDs
	// from the projected rows; paths that are no longer live (moved or
	// deleted files) are resolved by reading their blobs.
	live := map[string]string{}     // guid -> current hid
	pathGUID := map[string]string{} // repository path -> guid
	curPath := map[string]string{}  // live guid -> the path it had at the point of history being walked
	rows, err := p.sql.QueryContext(ctx, `SELECT guid, COALESCE(hid,''), file_path FROM artifacts`)
	if err != nil {
		return unavailable(err)
	}
	for rows.Next() {
		var g, h, path string
		if err := rows.Scan(&g, &h, &path); err != nil {
			rows.Close()
			return unavailable(err)
		}
		live[g] = h
		pathGUID[path] = g
		curPath[g] = path
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return unavailable(err)
	}

	type stamp struct {
		t time.Time
		c string
	}
	modified := map[string]stamp{}
	created := map[string]stamp{}
	pending := map[string]string{} // guid -> hid whose "since" commit is still unknown
	for g, h := range live {
		if h != "" {
			pending[g] = h
		}
	}
	type hidRow struct {
		guid, hid, since string
		at               time.Time
		until            string
	}
	var hidRows []hidRow
	type delRow struct {
		guid, path, commit, oldSHA string
		at                         time.Time
	}
	deleted := map[string]*delRow{}
	var events []histEvent
	commits := 0

	// flush resolves the GUID of every buffered event and applies it in walk
	// order (newest first).
	flush := func() error {
		if len(events) == 0 {
			return nil
		}
		need := map[string]bool{}
		for _, e := range events {
			if _, known := pathGUID[e.path]; !known {
				if e.status == 'D' {
					need[e.oldSHA] = true
				} else {
					need[e.newSHA] = true
				}
			}
			if e.status == 'M' {
				need[e.oldSHA], need[e.newSHA] = true, true
			}
			if e.status == 'D' {
				need[e.oldSHA] = true
			}
		}
		shas := make([]string, 0, len(need))
		for sha := range need {
			shas = append(shas, sha)
		}
		blobs, err := p.repo.ReadBlobs(ctx, shas)
		if err != nil {
			return err
		}
		hidOf := func(sha string) string {
			o, err := ojson.ParseObject(blobs[sha])
			if err != nil {
				return ""
			}
			return o.String("hid")
		}
		guidOf := func(e histEvent) string {
			if g, ok := pathGUID[e.path]; ok {
				return g
			}
			sha := e.newSHA
			if e.status == 'D' {
				sha = e.oldSHA
			}
			rec := extract(e.match, sha, blobs[sha])
			g := rec.GUID
			if g == "" {
				g = e.match.GUID
				if e.match.Category == scanner.ConfigFile {
					g = e.match.Name
				}
			}
			if model.IsGUID(g) {
				pathGUID[e.path] = g
			}
			return g
		}
		// Per commit: live GUIDs added at their current path and deleted at
		// another path resolving to the same GUID = a move, not a creation.
		addedAt := map[string]map[string]bool{}   // commit -> guid -> added at curPath
		deletedIn := map[string]map[string]bool{} // commit -> guid -> some other path deleted
		guids := make([]string, len(events))
		for i, e := range events {
			guids[i] = guidOf(e)
			if !model.IsGUID(guids[i]) {
				continue
			}
			if e.status == 'A' && curPath[guids[i]] == e.path {
				if addedAt[e.commit] == nil {
					addedAt[e.commit] = map[string]bool{}
				}
				addedAt[e.commit][guids[i]] = true
			}
			if e.status == 'D' && curPath[guids[i]] != e.path {
				if deletedIn[e.commit] == nil {
					deletedIn[e.commit] = map[string]bool{}
				}
				deletedIn[e.commit][guids[i]] = true
			}
		}
		// Within a commit, additions are applied before deletions so that the
		// addition half of a move is seen at the artifact's current path
		// before the deletion half rewinds that path.
		order := make([]int, len(events))
		for i := range order {
			order[i] = i
		}
		rank := func(st byte) int {
			if st == 'D' {
				return 1
			}
			return 0
		}
		sort.SliceStable(order, func(a, b int) bool {
			ea, eb := events[order[a]], events[order[b]]
			if ea.commit != eb.commit {
				return false // keep commit order (stable)
			}
			return rank(ea.status) < rank(eb.status)
		})
		for _, i := range order {
			e := events[i]
			guid := guids[i]
			if !model.IsGUID(guid) {
				continue
			}
			if _, isLive := live[guid]; isLive {
				if e.path != curPath[guid] {
					if e.status == 'D' && addedAt[e.commit][guid] {
						curPath[guid] = e.path // the artifact was moved here from e.path
					}
					// Otherwise a different file claims this GUID (an impostor,
					// recorded in file_issues): it is not this artifact's history.
					continue
				}
				if e.status == 'A' && deletedIn[e.commit][guid] {
					// The addition half of a move: not a creation.
					created[guid] = stamp{e.at, e.commit}
					if _, seen := modified[guid]; !seen {
						modified[guid] = stamp{e.at, e.commit}
					}
					continue
				}
				if _, seen := modified[guid]; !seen {
					modified[guid] = stamp{e.at, e.commit}
				}
				created[guid] = stamp{e.at, e.commit}
				switch e.status {
				case 'M':
					oldH, newH := hidOf(e.oldSHA), hidOf(e.newSHA)
					if oldH == newH {
						continue
					}
					if newH != "" {
						hidRows = append(hidRows, hidRow{guid: guid, hid: newH, since: e.commit, at: e.at})
					}
					if oldH != "" {
						hidRows = append(hidRows, hidRow{guid: guid, hid: oldH, since: "", at: e.at, until: e.commit})
					}
					pending[guid] = oldH
				case 'A':
					if h := pending[guid]; h != "" {
						hidRows = append(hidRows, hidRow{guid: guid, hid: h, since: e.commit, at: e.at})
					}
				}
				continue
			}
			// Not live: the newest deletion is recorded (§5.16) and the
			// artifact's earlier HID history is tracked from there on.
			switch e.status {
			case 'D':
				if _, done := deleted[guid]; !done {
					deleted[guid] = &delRow{guid: guid, path: e.path, commit: e.commit, oldSHA: e.oldSHA, at: e.at}
					if h := hidOf(e.oldSHA); h != "" {
						hidRows = append(hidRows, hidRow{guid: guid, hid: h, since: "", at: e.at, until: e.commit})
						pending[guid] = h
					}
				}
			case 'M':
				if _, tracked := deleted[guid]; !tracked {
					continue
				}
				oldH, newH := hidOf(e.oldSHA), hidOf(e.newSHA)
				if oldH == newH {
					continue
				}
				if newH != "" {
					hidRows = append(hidRows, hidRow{guid: guid, hid: newH, since: e.commit, at: e.at})
				}
				if oldH != "" {
					hidRows = append(hidRows, hidRow{guid: guid, hid: oldH, since: "", at: e.at, until: e.commit})
				}
				pending[guid] = oldH
			case 'A':
				if _, tracked := deleted[guid]; !tracked {
					continue
				}
				if h := pending[guid]; h != "" {
					hidRows = append(hidRows, hidRow{guid: guid, hid: h, since: e.commit, at: e.at})
				}
			}
		}
		events = events[:0]
		return nil
	}

	err = p.repo.Walk(ctx, head, func(cd gitx.CommitDiff) error {
		commits++
		if commits%500 == 0 {
			n := commits
			p.setStatus(func(s *Status) { s.Progress = n })
		}
		for _, ch := range cd.Changes {
			m, ok := sc.Match(ch.Path)
			if !ok {
				continue
			}
			isArtifact := m.Category == scanner.Artifact ||
				(m.Category == scanner.ConfigFile && (m.ConfigKind == scanner.ConfigLinks || m.ConfigKind == scanner.ConfigComments))
			if !isArtifact || (ch.Status != 'A' && ch.Status != 'M' && ch.Status != 'D') {
				continue
			}
			events = append(events, histEvent{path: ch.Path, oldSHA: ch.OldSHA, newSHA: ch.SHA, commit: cd.SHA, status: ch.Status, at: cd.Time, match: m})
		}
		if len(events) >= batchSize {
			return flush()
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := flush(); err != nil {
		return err
	}

	tx, err := p.Begin(ctx)
	if err != nil {
		return unavailable(err)
	}
	defer tx.Rollback()
	for g, m := range modified {
		c := created[g]
		if _, err := tx.ExecContext(ctx, `UPDATE artifacts SET modified_at = $1, modified_commit = $2, created_at = $3, created_commit = $4 WHERE guid = $5`,
			m.t, m.c, c.t, c.c, g); err != nil {
			return unavailable(err)
		}
	}
	// Rebuild HID history: rows for current HIDs already exist with since "".
	if _, err := tx.ExecContext(ctx, `DELETE FROM hid_history`); err != nil {
		return unavailable(err)
	}
	type key struct{ guid, hid string }
	since := map[key]hidRow{}
	until := map[key]string{}
	for _, r := range hidRows {
		k := key{r.guid, r.hid}
		if r.since != "" {
			since[k] = r // walking newest first, the last write is the oldest = true start
		}
		if r.until != "" {
			if _, have := until[k]; !have {
				until[k] = r.until
			}
		}
	}
	for g, h := range live {
		if h != "" {
			k := key{g, h}
			if _, ok := since[k]; !ok {
				since[k] = hidRow{guid: g, hid: h}
			}
		}
	}
	for k, r := range since {
		var u any
		if v, ok := until[k]; ok {
			u = v
		}
		var at any
		if !r.at.IsZero() {
			at = r.at
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO hid_history (guid, hid, since_commit, since_at, until_commit) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
			k.guid, k.hid, r.since, at, u); err != nil {
			return unavailable(err)
		}
	}
	for k, u := range until {
		if _, ok := since[k]; ok {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO hid_history (guid, hid, since_commit, until_commit) VALUES ($1,$2,'',$3) ON CONFLICT DO NOTHING`, k.guid, k.hid, u); err != nil {
			return unavailable(err)
		}
	}
	// Deleted artifacts: read their last content for metadata.
	var shas []string
	for _, d := range deleted {
		shas = append(shas, d.oldSHA)
	}
	for start := 0; start < len(shas); start += batchSize {
		blobs, err := p.repo.ReadBlobs(ctx, shas[start:min(start+batchSize, len(shas))])
		if err != nil {
			return err
		}
		for _, d := range deleted {
			content, ok := blobs[d.oldSHA]
			if !ok {
				continue
			}
			m := sc.Classify(d.path)
			rec := extract(m, d.oldSHA, content)
			var hid any
			if rec.HID != "" {
				hid = rec.HID
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO deleted_artifacts (guid, kind, type, title, hid, last_path, deleted_commit, deleted_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, d.guid, string(rec.Kind), rec.Type, rec.Title, hid, d.path, d.commit, d.at); err != nil {
				return unavailable(err)
			}
		}
	}
	return unavailable(tx.Commit())
}

var _ = sql.ErrNoRows

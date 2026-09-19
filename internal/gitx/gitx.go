// Package gitx drives a bare Git repository through plumbing commands.
//
// The Foundation never maintains a working directory (design guide §3.8,
// §5.3): every commit is assembled from blobs, a private temporary index
// and commit-tree, and published with a compare-and-swap update-ref. All
// reads are batched (ls-tree, cat-file --batch) and all user-controlled
// paths are passed as literal pathspecs so folder names can never be
// interpreted as pathspec magic.
package gitx

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// ZeroSHA is the object name Git uses for "does not exist".
	ZeroSHA = "0000000000000000000000000000000000000000"
	// EmptyTree is the well-known object name of the empty tree.
	EmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
)

var (
	// ErrStale is returned by Publish when the branch no longer points at
	// the expected revision. Nothing has been published in that case.
	ErrStale = errors.New("gitx: branch moved since the changeset was built")
	// ErrNotFound is returned when a requested object or path does not exist.
	ErrNotFound = errors.New("gitx: not found")
)

type authorKey struct{}

// WithAuthor returns a context whose commits are authored by name (the
// committer stays the repository identity). Characters Git cannot store in an
// identity are dropped; an empty name leaves the default author in place.
func WithAuthor(ctx context.Context, name string) context.Context {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '<' || r == '>' || r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name))
	if len(name) > 200 {
		name = strings.ToValidUTF8(name[:200], "")
	}
	if name == "" {
		return ctx
	}
	return context.WithValue(ctx, authorKey{}, name)
}

// Repo is a handle to a bare repository and the branch the Foundation owns.
type Repo struct {
	Dir    string
	Branch string
	Author string
	Email  string
}

// Open opens the bare repository at dir, creating it when it does not exist.
func Open(dir, branch string) (*Repo, error) {
	if branch == "" {
		branch = "main"
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	r := &Repo{Dir: abs, Branch: branch, Author: "Corestone", Email: "corestone@localhost"}
	if _, err := os.Stat(filepath.Join(abs, "HEAD")); err != nil {
		if err := os.MkdirAll(abs, 0o755); err != nil {
			return nil, err
		}
		if _, err := r.run(context.Background(), nil, "init", "--bare", "-q", "--initial-branch="+branch); err != nil {
			return nil, err
		}
	}
	// Paths are always emitted verbatim; NUL-terminated streams make that safe.
	if _, err := r.run(context.Background(), nil, "config", "core.quotepath", "false"); err != nil {
		return nil, err
	}
	return r, nil
}

// Ref is the full reference name of the managed branch.
func (r *Repo) Ref() string { return "refs/heads/" + r.Branch }

func (r *Repo) cmd(ctx context.Context, args ...string) *exec.Cmd {
	c := exec.CommandContext(ctx, "git", args...)
	c.Env = append(os.Environ(),
		"GIT_DIR="+r.Dir,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	)
	return c
}

func (r *Repo) run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	c := r.cmd(ctx, args...)
	if stdin != nil {
		c.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		if ctx.Err() != nil {
			// The process was killed because the caller gave up; report the
			// cancellation, not the signal, so callers can recognize it.
			err = fmt.Errorf("%w (%v)", ctx.Err(), err)
		}
		return out.Bytes(), &Error{Args: args, Err: err, Stderr: strings.TrimSpace(errb.String())}
	}
	return out.Bytes(), nil
}

// Error carries the failing git invocation and its stderr.
type Error struct {
	Args   []string
	Err    error
	Stderr string
}

func (e *Error) Error() string {
	return fmt.Sprintf("git %s: %v: %s", strings.Join(e.Args, " "), e.Err, e.Stderr)
}

func (e *Error) Unwrap() error { return e.Err }

// ExitCode returns the process exit code or -1.
func (e *Error) ExitCode() int {
	var xe *exec.ExitError
	if errors.As(e.Err, &xe) {
		return xe.ExitCode()
	}
	return -1
}

// Head returns the commit the branch points at, or "" for an unborn branch.
// Only exit code 1 ("no such ref") maps to "empty"; every other failure is
// returned as an error so a broken repository can never look empty.
func (r *Repo) Head(ctx context.Context) (string, error) {
	out, err := r.run(ctx, nil, "rev-parse", "-q", "--verify", r.Ref()+"^{commit}")
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && ge.ExitCode() == 1 {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// TreeEntry is one blob in a tree listing.
type TreeEntry struct {
	Path string
	SHA  string
	Mode string
	Size int64
}

// ListTree lists every blob reachable from rev (a commit or tree). An empty
// rev yields an empty listing.
func (r *Repo) ListTree(ctx context.Context, rev string) ([]TreeEntry, error) {
	if rev == "" {
		return nil, nil
	}
	out, err := r.run(ctx, nil, "ls-tree", "-r", "-z", "-l", "--full-tree", rev)
	if err != nil {
		return nil, err
	}
	var entries []TreeEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, path, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			continue
		}
		f := strings.Fields(string(meta))
		if len(f) < 4 || f[1] != "blob" {
			continue
		}
		size, _ := strconv.ParseInt(f[3], 10, 64)
		entries = append(entries, TreeEntry{Path: string(path), SHA: f[2], Mode: f[0], Size: size})
	}
	return entries, nil
}

// ReadBlobs fetches many blobs in one cat-file process. Missing objects are
// simply absent from the result.
func (r *Repo) ReadBlobs(ctx context.Context, shas []string) (map[string][]byte, error) {
	res := make(map[string][]byte, len(shas))
	if len(shas) == 0 {
		return res, nil
	}
	var in bytes.Buffer
	for _, s := range shas {
		in.WriteString(s)
		in.WriteByte('\n')
	}
	out, err := r.run(ctx, in.Bytes(), "cat-file", "--batch")
	if err != nil {
		return nil, err
	}
	for len(out) > 0 {
		nl := bytes.IndexByte(out, '\n')
		if nl < 0 {
			break
		}
		hdr := strings.Fields(string(out[:nl]))
		out = out[nl+1:]
		if len(hdr) == 2 && hdr[1] == "missing" {
			continue
		}
		if len(hdr) != 3 {
			return nil, fmt.Errorf("gitx: unexpected cat-file header %q", hdr)
		}
		n, err := strconv.Atoi(hdr[2])
		if err != nil || n > len(out) {
			return nil, fmt.Errorf("gitx: bad cat-file length %q", hdr[2])
		}
		if hdr[1] == "blob" {
			res[hdr[0]] = append([]byte(nil), out[:n]...)
		}
		out = out[n:]
		if len(out) > 0 && out[0] == '\n' {
			out = out[1:]
		}
	}
	return res, nil
}

// ReadBlob returns one blob's content.
func (r *Repo) ReadBlob(ctx context.Context, sha string) ([]byte, error) {
	m, err := r.ReadBlobs(ctx, []string{sha})
	if err != nil {
		return nil, err
	}
	b, ok := m[sha]
	if !ok {
		return nil, ErrNotFound
	}
	return b, nil
}

// ReadPath returns the blob at path in rev together with its object name.
func (r *Repo) ReadPath(ctx context.Context, rev, path string) ([]byte, string, error) {
	if rev == "" {
		return nil, "", ErrNotFound
	}
	out, err := r.run(ctx, nil, "ls-tree", "-z", "--full-tree", rev, "--", Literal(path))
	if err != nil {
		return nil, "", err
	}
	rec, _, _ := bytes.Cut(out, []byte{0})
	meta, _, ok := bytes.Cut(rec, []byte{'\t'})
	if !ok {
		return nil, "", ErrNotFound
	}
	f := strings.Fields(string(meta))
	if len(f) < 3 || f[1] != "blob" {
		return nil, "", ErrNotFound
	}
	b, err := r.ReadBlob(ctx, f[2])
	return b, f[2], err
}

// Literal wraps a path so git treats it verbatim rather than as pathspec magic.
func Literal(path string) string { return ":(literal)" + path }

// Op is one file operation inside a changeset.
type Op struct {
	Path    string
	Content []byte
	Delete  bool
}

// BuildCommit assembles a commit on top of parent from ops and returns its
// object name without publishing it (design guide §10.1: "the new commit
// object exists but is not yet visible"). parent may be "" for a root commit.
func (r *Repo) BuildCommit(ctx context.Context, parent, message string, ops []Op) (string, error) {
	idx, err := os.CreateTemp("", "corestone-index-*")
	if err != nil {
		return "", err
	}
	idxPath := idx.Name()
	idx.Close()
	os.Remove(idxPath)
	defer os.Remove(idxPath)

	withIndex := func(c *exec.Cmd) *exec.Cmd {
		c.Env = append(c.Env, "GIT_INDEX_FILE="+idxPath)
		return c
	}
	runIdx := func(stdin []byte, args ...string) ([]byte, error) {
		c := withIndex(r.cmd(ctx, args...))
		if stdin != nil {
			c.Stdin = bytes.NewReader(stdin)
		}
		var out, errb bytes.Buffer
		c.Stdout, c.Stderr = &out, &errb
		if err := c.Run(); err != nil {
			return nil, &Error{Args: args, Err: err, Stderr: strings.TrimSpace(errb.String())}
		}
		return out.Bytes(), nil
	}

	if parent != "" {
		if _, err := runIdx(nil, "read-tree", parent); err != nil {
			return "", err
		}
	} else if _, err := runIdx(nil, "read-tree", "--empty"); err != nil {
		return "", err
	}

	var info bytes.Buffer
	for _, op := range ops {
		if strings.ContainsAny(op.Path, "\x00\n") || op.Path == "" {
			return "", fmt.Errorf("gitx: invalid path %q", op.Path)
		}
		if op.Delete {
			fmt.Fprintf(&info, "0 %s\t%s\x00", ZeroSHA, op.Path)
			continue
		}
		out, err := r.run(ctx, op.Content, "hash-object", "-w", "--stdin")
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&info, "100644 blob %s\t%s\x00", strings.TrimSpace(string(out)), op.Path)
	}
	if info.Len() > 0 {
		if _, err := runIdx(info.Bytes(), "update-index", "-z", "--index-info"); err != nil {
			return "", err
		}
	}
	treeOut, err := runIdx(nil, "write-tree")
	if err != nil {
		return "", err
	}
	tree := strings.TrimSpace(string(treeOut))

	args := []string{"commit-tree", tree, "-F", "-"}
	if parent != "" {
		args = append(args, "-p", parent)
	}
	c := r.cmd(ctx, args...)
	now := time.Now().Format(time.RFC3339)
	author := r.Author
	if name, ok := ctx.Value(authorKey{}).(string); ok {
		author = name
	}
	c.Env = append(c.Env,
		"GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL="+r.Email, "GIT_AUTHOR_DATE="+now,
		"GIT_COMMITTER_NAME="+r.Author, "GIT_COMMITTER_EMAIL="+r.Email, "GIT_COMMITTER_DATE="+now)
	c.Stdin = strings.NewReader(message)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		return "", &Error{Args: args, Err: err, Stderr: strings.TrimSpace(errb.String())}
	}
	return strings.TrimSpace(out.String()), nil
}

// Publish atomically moves the branch from oldSHA to newSHA (compare-and-swap
// update-ref). oldSHA "" means the branch must not exist yet. Returns
// ErrStale if the branch is not at oldSHA.
func (r *Repo) Publish(ctx context.Context, oldSHA, newSHA string) error {
	if oldSHA == "" {
		oldSHA = ZeroSHA
	}
	_, err := r.run(ctx, nil, "update-ref", r.Ref(), newSHA, oldSHA)
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && (strings.Contains(ge.Stderr, "cannot lock ref") || strings.Contains(ge.Stderr, "but expected")) {
			return ErrStale
		}
		return err
	}
	return nil
}

// TreeOf returns the tree object of a commit.
func (r *Repo) TreeOf(ctx context.Context, commit string) (string, error) {
	out, err := r.run(ctx, nil, "rev-parse", commit+"^{tree}")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// CommitRef is a commit with its parents.
type CommitRef struct {
	SHA     string
	Parents []string
}

// FirstParentChain lists the commits on the first-parent chain of `to` that
// are not reachable from `from`, oldest first. from may be "".
func (r *Repo) FirstParentChain(ctx context.Context, from, to string) ([]CommitRef, error) {
	rng := to
	if from != "" {
		rng = from + ".." + to
	}
	out, err := r.run(ctx, nil, "rev-list", "--reverse", "--first-parent", "--parents", rng)
	if err != nil {
		return nil, err
	}
	var chain []CommitRef
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		chain = append(chain, CommitRef{SHA: f[0], Parents: f[1:]})
	}
	return chain, nil
}

// IsAncestor reports whether a is an ancestor of (or equal to) b.
func (r *Repo) IsAncestor(ctx context.Context, a, b string) (bool, error) {
	_, err := r.run(ctx, nil, "merge-base", "--is-ancestor", a, b)
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && ge.ExitCode() == 1 {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Exists reports whether an object exists in the repository.
func (r *Repo) Exists(ctx context.Context, sha string) bool {
	_, err := r.run(ctx, nil, "cat-file", "-e", sha)
	return err == nil
}

// Change is one path affected by a commit.
type Change struct {
	Status byte // 'A', 'M', 'D', 'T'
	Path   string
	OldSHA string
	SHA    string
}

// DiffTree lists the blob-level changes between two revisions (no rename
// detection: a rename is a deletion plus an addition, which is what the
// projection needs). from may be "" or EmptyTree for a root diff.
func (r *Repo) DiffTree(ctx context.Context, from, to string) ([]Change, error) {
	if from == "" {
		from = EmptyTree
	}
	out, err := r.run(ctx, nil, "diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, to)
	if err != nil {
		return nil, err
	}
	return parseRaw(out)
}

func parseRaw(out []byte) ([]Change, error) {
	var changes []Change
	fields := bytes.Split(out, []byte{0})
	for i := 0; i+1 < len(fields); i += 2 {
		meta := string(fields[i])
		if !strings.HasPrefix(meta, ":") {
			continue
		}
		f := strings.Fields(meta[1:])
		if len(f) < 5 {
			return nil, fmt.Errorf("gitx: unexpected raw diff record %q", meta)
		}
		changes = append(changes, Change{Status: f[4][0], Path: string(fields[i+1]), OldSHA: f[2], SHA: f[3]})
	}
	return changes, nil
}

// LogEntry is one commit in a history listing.
type LogEntry struct {
	SHA      string            `json:"sha"`
	Parents  []string          `json:"parents,omitempty"`
	Author   string            `json:"author"`
	Email    string            `json:"email"`
	Time     time.Time         `json:"time"`
	Subject  string            `json:"subject"`
	Body     string            `json:"body,omitempty"`
	Trailers map[string]string `json:"trailers,omitempty"`
}

const logFormat = "%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%(trailers:only,unfold)%x00"

// Log lists commits reachable from rev that touch any of the pathspecs
// (all commits when none are given), newest first.
func (r *Repo) Log(ctx context.Context, rev string, pathspecs []string, limit int) ([]LogEntry, error) {
	if rev == "" {
		return nil, nil
	}
	args := []string{"log", "-z", "--format=" + logFormat}
	if limit > 0 {
		args = append(args, "-n", strconv.Itoa(limit))
	}
	args = append(args, rev)
	if len(pathspecs) > 0 {
		args = append(args, "--")
		args = append(args, pathspecs...)
	}
	out, err := r.run(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	return parseLog(out), nil
}

func parseLog(out []byte) []LogEntry {
	var entries []LogEntry
	fields := bytes.Split(out, []byte{0})
	for i := 0; i+7 < len(fields); i += 9 { // 8 fields + the -z record separator
		ts, _ := strconv.ParseInt(string(fields[i+4]), 10, 64)
		e := LogEntry{
			SHA:     string(fields[i]),
			Author:  string(fields[i+2]),
			Email:   string(fields[i+3]),
			Time:    time.Unix(ts, 0).UTC(),
			Subject: string(fields[i+5]),
			Body:    strings.TrimSpace(string(fields[i+6])),
		}
		if p := strings.Fields(string(fields[i+1])); len(p) > 0 {
			e.Parents = p
		}
		e.Trailers = parseTrailers(string(fields[i+7]))
		if e.Trailers != nil {
			// The body already contains the trailers; keep only the free text.
			if idx := strings.LastIndex(e.Body, "\n\n"); idx >= 0 && looksLikeTrailers(e.Body[idx+2:]) {
				e.Body = strings.TrimSpace(e.Body[:idx])
			} else if looksLikeTrailers(e.Body) {
				e.Body = ""
			}
		}
		entries = append(entries, e)
	}
	return entries
}

func looksLikeTrailers(s string) bool {
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		if !strings.Contains(line, ": ") {
			return false
		}
	}
	return s != ""
}

func parseTrailers(s string) map[string]string {
	var m map[string]string
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if m == nil {
			m = map[string]string{}
		}
		m[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return m
}

// CommitDiff is a commit together with the changes against its first parent.
type CommitDiff struct {
	SHA     string
	Parent  string // first parent or ""
	Time    time.Time
	Subject string
	Changes []Change
}

// Walk streams the first-parent history of rev, newest first, with the raw
// changes of every commit, using a single git process.
func (r *Repo) Walk(ctx context.Context, rev string, fn func(CommitDiff) error) error {
	if rev == "" {
		return nil
	}
	c := r.cmd(ctx, "log", "-z", "--raw", "--no-renames", "--no-abbrev", "--first-parent",
		"--format=%x01%H %P %at%x02%s%x02", rev)
	var errb bytes.Buffer
	c.Stderr = &errb
	out, err := c.Output()
	if err != nil {
		return &Error{Args: c.Args[1:], Err: err, Stderr: strings.TrimSpace(errb.String())}
	}
	for _, rec := range bytes.Split(out, []byte{1}) {
		if len(rec) == 0 {
			continue
		}
		hdr, rest, ok := bytes.Cut(rec, []byte{2})
		if !ok {
			continue
		}
		subject, rest, _ := bytes.Cut(rest, []byte{2})
		f := strings.Fields(string(hdr))
		if len(f) < 2 {
			continue
		}
		cd := CommitDiff{SHA: f[0], Subject: string(subject)}
		ts, _ := strconv.ParseInt(f[len(f)-1], 10, 64)
		cd.Time = time.Unix(ts, 0).UTC()
		if len(f) > 2 {
			cd.Parent = f[1]
		}
		rest = bytes.TrimPrefix(rest, []byte{0})
		rest = bytes.TrimPrefix(rest, []byte{'\n'})
		if len(rest) > 0 {
			ch, err := parseRaw(rest)
			if err != nil {
				return err
			}
			cd.Changes = ch
		}
		if err := fn(cd); err != nil {
			return err
		}
	}
	return nil
}

// BlobSHA computes the object name a blob with this content would have,
// without touching the repository. It is used as the artifact ETag.
func BlobSHA(content []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(content))
	h.Write(content)
	return hex.EncodeToString(h.Sum(nil))
}

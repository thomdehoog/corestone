#!/usr/bin/env bash
# REST end-to-end check: seeds a demo domain into a running corestone and
# asserts on real responses across the whole artifact lifecycle.
#
#   ./scripts/e2e.sh [http://127.0.0.1:8080]
set -euo pipefail
BASE=${1:-http://127.0.0.1:8080}
API=$BASE/api
fail() { echo "E2E FAIL: $*" >&2; exit 1; }
py() { python3 -c "import json,sys; $1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

"$(dirname "$0")/../examples/seed.sh" "$BASE" >/dev/null

# Search finds the seeded requirement; field and state filters work.
R1=$(curl -sfS "$API/repository/search?q=selling" | py "d=json.load(sys.stdin); assert d['total']==1, d; print(d['artifacts'][0]['guid'])")
curl -sfS "$API/repository/search?state.dev=review&kind=entry" | py "assert json.load(sys.stdin)['total']==1"
curl -sfS "$API/repository/search?field.priority=high&path=specs" | py "assert json.load(sys.stdin)['total']==2"

# Effective schema composes root and subtree definitions.
curl -sfS "$API/schemas/effective?type=requirement&path=specs/safety" | py "
s=json.load(sys.stdin); ids=[f['id'] for f in s['fields']]; assert 'asil' in ids and 'priority' in ids, ids; assert s['sources']==['', 'specs/safety'], s['sources']"

# Overlay analysis: variant inherits rationale, overrides priority.
V=$(curl -sfS "$API/repository/search?hid=REQ-4" | py "print(json.load(sys.stdin)['artifacts'][0]['guid'])")
curl -sfS "$API/artifacts/$V/overlay" | py "
d=json.load(sys.stdin); assert d['fields']['priority']=='medium' and 'selling' in d['fields']['rationale'], d; assert d['origin']['rationale']=='$R1'"

# ETag / If-Match: fresh 200, stale 412.
ETAG=$(curl -sfSI "$API/entries/$R1" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
[ "$(code -X PUT "$API/entries/$R1" -H "If-Match: $ETAG" -H 'Content-Type: application/json' -d '{"title":"e2e updated"}')" = 200 ] || fail "fresh If-Match"
[ "$(code -X PUT "$API/entries/$R1" -H "If-Match: $ETAG" -H 'Content-Type: application/json' -d '{"title":"clobber"}')" = 412 ] || fail "stale If-Match"
[ "$(code "$API/documents/$R1")" = 404 ] || fail "kind-checked route"

# Workflow evaluation and an illegal transition.
curl -sfS "$API/artifacts/$R1/workflows" | py "
w={x['id']:x for x in json.load(sys.stdin)['workflows']}; assert w['dev']['state']=='review' and w['publish']['state']=='draft', w
assert {t['id'] for t in w['dev']['available']}=={'approve','rework'}, w['dev']['available']"
[ "$(code -X POST "$API/artifacts/$R1/transition" -H 'Content-Type: application/json' -d '{"workflow":"publish","to":"draft"}')" = 400 ] || fail "illegal transition accepted"

# Relationship analysis lists the verifying test and allowed link types.
curl -sfS "$API/artifacts/$R1/relationships" | py "
d=json.load(sys.stdin); assert len(d['incoming'])==1 and d['incoming'][0]['link']['type']=='verifies', d
assert 'verifies' in [s['type'] for s in d['allowedAsTarget']], d"

# Move keeps identity, workflow state, comments and history.
curl -sfS -X POST "$API/artifacts/$R1/move" -H 'Content-Type: application/json' -d '{"path":"archive/e2e"}' >/dev/null
curl -sfS "$API/entries/$R1" | py "m=json.load(sys.stdin)['meta']; assert m['folder']=='archive/e2e' and m['workflows']['dev']=='review', m"
curl -sfS "$API/artifacts/$R1/comments" | py "c=json.load(sys.stdin)['comments']; assert len(c)==2 and c[1]['data']['parent']==c[0]['meta']['guid'], c"
curl -sfS "$API/artifacts/$R1/history" | py "
h=json.load(sys.stdin)['history']; assert any('moved' in e['subject'] for e in h) and h[-1]['trailers']['Corestone-Op']=='create', h"

# HID lookup, validation, deleted tracking, reindex convergence.
curl -sfS "$API/repository/hids/REQ-1" | py "assert json.load(sys.stdin)['records'][0]['guid']=='$R1'"
curl -sfS "$API/repository/validate" | py "assert json.load(sys.stdin)['errors']==0"
T2=$(curl -sfS "$API/repository/search?q=busy+loop" | py "print(json.load(sys.stdin)['artifacts'][0]['guid'])")
[ "$(code -X DELETE "$API/entries/$T2")" = 204 ] || fail "delete"
curl -sfS "$API/repository/deleted" | py "d=json.load(sys.stdin)['deleted']; assert any(x['guid']=='$T2' for x in d), d"
[ "$(code -X POST "$API/repository/reindex")" = 202 ] || fail "reindex"
for i in $(seq 1 100); do
  curl -sfS "$API/repository" | py "d=json.load(sys.stdin); sys.exit(0 if (not d['projection']['maintenance'] and d['inSync']) else 1)" && break
  sleep 0.1
done
curl -sfS "$API/entries/$R1" | py "assert json.load(sys.stdin)['meta']['folder']=='archive/e2e'"
curl -sfS "$API/repository/deleted" | py "d=json.load(sys.stdin)['deleted']; assert any(x['guid']=='$T2' for x in d), d"
curl -sfS "$API/repository/hids/REQ-1" | py "assert json.load(sys.stdin)['records'][0]['guid']=='$R1'"

echo "E2E PASS"

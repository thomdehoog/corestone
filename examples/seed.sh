#!/usr/bin/env bash
# Seeds a running corestone with a small requirements-management domain:
# workflows, schemas (entries, a document type, link types), entries with
# overlays, a document composed of entry references, links and comments.
#
#   ./examples/seed.sh [http://127.0.0.1:8080]
set -euo pipefail
API=${1:-http://127.0.0.1:8080}/api

post() { curl -sfS -X POST "$API/$1" -H 'Content-Type: application/json' -d "$2"; }
put()  { curl -sfS -X PUT  "$API/$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
guid() { python3 -c 'import json,sys; print(json.load(sys.stdin)["meta"]["guid"])'; }

put "workflows/dev" '{"id":"dev","name":"Development","initial":"open",
  "states":[{"id":"open","name":"Open"},{"id":"review","name":"In review","color":"#b7791f"},{"id":"done","name":"Done","color":"#1f9d55"}],
  "transitions":[{"id":"submit","name":"Submit for review","from":"open","to":"review"},
                 {"id":"approve","name":"Approve","from":"review","to":"done"},
                 {"id":"rework","name":"Request rework","from":"review","to":"open"},
                 {"id":"reopen","name":"Reopen","from":"done","to":"open"}]}'
put "workflows/publish" '{"id":"publish","name":"Publishing","initial":"draft","states":["draft","released"],
  "transitions":[{"id":"release","from":"draft","to":"released"},{"id":"withdraw","from":"released","to":"draft"}]}'

put "schemas/requirement" '{"type":"requirement","displayName":"Requirement","description":"A single verifiable statement of need",
  "hid":{"prefix":"REQ"},"workflows":["dev","publish"],
  "fields":[{"id":"priority","name":"Priority","type":"enum","required":true,"options":[{"value":"low"},{"value":"medium"},{"value":"high","color":"#d6455d"}]},
            {"id":"rationale","name":"Rationale","type":"multiline"},
            {"id":"effort","name":"Effort (days)","type":"integer"},
            {"id":"due","name":"Due","type":"date"},
            {"id":"tags","name":"Tags","type":"enum","multiple":true,"extendable":true,"options":[{"value":"safety"},{"value":"performance"},{"value":"ux"}]},
            {"id":"spec","name":"Spec link","type":"hyperlink"}],
  "presentation":{"columns":["priority","effort","due"],"icon":"list-check"}}'
put "schemas/testcase" '{"type":"testcase","displayName":"Test case","hid":{"prefix":"TC","digits":3},"workflows":["dev"],
  "fields":[{"id":"steps","name":"Steps","type":"multiline"},{"id":"automated","name":"Automated","type":"boolean"},
            {"id":"owner","name":"Owner","type":"text"}]}'
put "schemas/component" '{"type":"component","displayName":"Component","hid":{"prefix":"CMP"},
  "fields":[{"id":"vendor","name":"Vendor","type":"text"},{"id":"cost","name":"Unit cost","type":"currency","currency":"EUR"},
            {"id":"parts","name":"Sub-components","type":"references","targetTypes":["component"]}]}'
put "schemas/spec" '{"type":"spec","kind":"document","displayName":"Specification","hid":{"prefix":"SPEC"},"workflows":["publish"],
  "fields":[{"id":"audience","name":"Audience","type":"enum","options":[{"value":"internal"},{"value":"customer"}]}]}'
put "schemas/verifies" '{"type":"verifies","kind":"link","displayName":"verifies","sourceTypes":["testcase"],"targetTypes":["requirement"],"cardinality":"many-to-many",
  "fields":[{"id":"coverage","name":"Coverage","type":"enum","options":[{"value":"full"},{"value":"partial"}]}]}'
put "schemas/implements" '{"type":"implements","kind":"link","displayName":"implements","sourceTypes":["component"],"targetTypes":["requirement"],"cardinality":"many-to-many"}'
put "schemas/related" '{"type":"related","kind":"link","displayName":"related to"}'
# a subtree that refines the requirement type: an extra field, a stricter priority list
put "schemas/requirement?scope=specs/safety" '{"type":"requirement","fields":[{"id":"asil","name":"ASIL","type":"enum","options":[{"value":"A"},{"value":"B"},{"value":"C"},{"value":"D"}]}]}'

R1=$(post entries '{"path":"specs/boot","type":"requirement","title":"System boots in under 2 seconds",
  "fields":{"priority":"high","rationale":"Startup latency is a key selling point.","effort":5,"due":"2026-12-01","tags":["performance"]}}' | guid)
R2=$(post entries '{"path":"specs/boot","type":"requirement","title":"Boot progress is displayed",
  "fields":{"priority":"low","effort":2,"tags":["ux"]}}' | guid)
R3=$(post entries '{"path":"specs/safety","type":"requirement","title":"Watchdog resets a hung system within 500 ms",
  "fields":{"priority":"high","asil":"C","tags":["safety"],"effort":8}}' | guid)
V1=$(post entries "{\"path\":\"specs/boot/variants\",\"type\":\"requirement\",\"title\":\"Variant: embedded boot in under 4 seconds\",
  \"base\":\"$R1\",\"fields\":{\"priority\":\"medium\",\"effort\":3}}" | guid)
T1=$(post entries '{"path":"tests","type":"testcase","title":"Measure cold boot time","fields":{"automated":true,"owner":"QA","steps":"1. Power off\n2. Power on\n3. Stop the clock at the login prompt"}}' | guid)
T2=$(post entries '{"path":"tests","type":"testcase","title":"Trigger watchdog with a busy loop","fields":{"automated":false,"owner":"HW lab"}}' | guid)
C1=$(post entries '{"path":"hardware","type":"component","title":"Main board","fields":{"vendor":"Acme","cost":149.5}}' | guid)
C2=$(post entries "{\"path\":\"hardware\",\"type\":\"component\",\"title\":\"Watchdog timer IC\",\"fields\":{\"vendor\":\"Acme\",\"cost\":2.1}}" | guid)
curl -sfS -X PUT "$API/entries/$C1" -H 'Content-Type: application/json' -d "{\"fields\":{\"parts\":[\"$C2\"]}}" >/dev/null

post links "{\"type\":\"verifies\",\"source\":\"$T1\",\"target\":\"$R1\",\"fields\":{\"coverage\":\"full\"}}" >/dev/null
post links "{\"type\":\"verifies\",\"source\":\"$T2\",\"target\":\"$R3\"}" >/dev/null
post links "{\"type\":\"implements\",\"source\":\"$C2\",\"target\":\"$R3\"}" >/dev/null
post links "{\"type\":\"related\",\"source\":\"$R1\",\"target\":\"$R2\"}" >/dev/null
CM=$(post comments "{\"subject\":\"$R1\",\"author\":\"alice\",\"text\":\"Is 2 s realistic on the low-end SKU?\"}" | guid)
post comments "{\"subject\":\"$R1\",\"parent\":\"$CM\",\"author\":\"bob\",\"text\":\"With the new bootloader, yes. See the variant for embedded.\"}" >/dev/null
post comments "{\"subject\":\"$R3\",\"author\":\"carol\",\"text\":\"Needs ASIL C evidence before release.\"}" >/dev/null

D1=$(post documents "{\"path\":\"docs\",\"type\":\"spec\",\"title\":\"Boot Specification\",\"fields\":{\"audience\":\"customer\"},
  \"content\":[{\"id\":\"s1\",\"type\":\"section\",\"title\":\"Timing\",\"children\":[
    {\"id\":\"p1\",\"type\":\"paragraph\",\"text\":\"The following requirements apply to every product variant:\"},
    {\"id\":\"e1\",\"type\":\"entry\",\"guid\":\"$R1\"},{\"id\":\"e2\",\"type\":\"entry\",\"guid\":\"$R2\"}]},
   {\"id\":\"s2\",\"type\":\"section\",\"title\":\"Safety\",\"children\":[
    {\"id\":\"p2\",\"type\":\"paragraph\",\"text\":\"Safety requirements are owned by the safety team and refined under specs/safety.\"},
    {\"id\":\"e3\",\"type\":\"entry\",\"guid\":\"$R3\"},
    {\"id\":\"l1\",\"type\":\"list\",\"items\":[{\"id\":\"i1\",\"type\":\"paragraph\",\"text\":\"Evidence: watchdog test report\"},{\"id\":\"i2\",\"type\":\"paragraph\",\"text\":\"Evidence: FMEA sheet\"}]}]}]}" | guid)
post "artifacts/$R1/transition" '{"workflow":"dev","to":"submit"}' >/dev/null
post "artifacts/$R3/transition" '{"workflow":"dev","to":"submit"}' >/dev/null
post "artifacts/$R3/transition" '{"workflow":"dev","to":"approve"}' >/dev/null
post "artifacts/$D1/transition" '{"workflow":"publish","to":"release"}' >/dev/null

echo "Seeded: requirements $R1 $R2 $R3, variant $V1, tests $T1 $T2, components $C1 $C2, document $D1"

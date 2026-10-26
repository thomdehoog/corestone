#!/usr/bin/env bash
# Large, isolated technical portfolio. Requires bash and Python 3.9+ (stdlib only).
#   bash examples/seed-large.sh [URL] [--count 1000] [--scale 100] [--root scale-lab]
#   bash examples/seed-large.sh --dry-run --scale 1000
# Writes through the API; never edits the Git repository directly. See docs/INSTALL.md.
set -euo pipefail
exec "${PYTHON:-python3}" - "$@" <<'PY'
import argparse
from collections import Counter
from datetime import date, timedelta
import hashlib
import json
import random
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid


PROJECTS = [
    dict(id="tideline-pi", name="Tideline coastal sensor gateway", weight=200, prefix="TIDE",
         layout="wide", independent=False, roles=["requirement", "specification", "testcase", "bug", "task", "component"],
         modules=["boot/secure-loader", "kernel/device-tree", "drivers/spi-adc", "drivers/i2c-sensors",
                  "services/sample-clock", "services/local-buffer", "network/lte-uplink", "updates/ab-slots",
                  "power/brownout", "observability/field-diagnostics"],
         features=["signed FIT image verification", "ADS131M04 DMA acquisition", "PPS-disciplined sample timestamps",
                   "SQLite WAL spool recovery", "MQTT QoS 1 replay", "A/B rootfs rollback",
                   "device-tree overlay selection", "I2C bus recovery", "LTE modem reconnect", "watchdog handover"],
         focus="Raspberry Pi CM4 on an isolated RS-485 carrier; Linux 6.6 LTS, SPI ADC and intermittent LTE",
         extra=("target_os", "Target OS", ["bootloader", "linux", "initramfs"]),
         states=["proposed", "implemented", "bench-tested", "field-qualified"],
         priorities=["low", "medium", "high", "urgent"], unit="ms"),
    dict(id="verdant-mcu", name="Verdant irrigation pump controller", weight=120, prefix="VERD",
         layout="flat", independent=True, roles=["requirement", "verification", "defect", "task"],
         modules=["adc-front-end", "pwm-scheduler", "canopen-node", "pressure-loop", "nonvolatile-settings", "production-jig"],
         features=["STM32G4 timer synchronization", "pressure-sensor plausibility", "CANopen heartbeat recovery",
                   "flash journal wear leveling", "PWM dead-time configuration", "dry-run pump cutoff",
                   "fixed-point PI saturation", "factory calibration CRC", "brownout restart inhibition", "SWD production unlock"],
         focus="24 V irrigation pump driver; STM32G474, 20 kHz PWM, isolated CAN and redundant pressure sensing",
         extra=("assurance", "Assurance class", ["standard", "reviewed", "independent-check"]),
         states=["captured", "reviewed", "implemented", "verified", "accepted"],
         priorities=["cosmetic", "normal", "important", "release-blocker"], unit="us"),
    dict(id="harbor-web", name="Harbor fleet operations web platform", weight=220, prefix="HWEB",
         layout="wide", independent=False, roles=["story", "requirement", "testcase", "bug", "task", "component"],
         modules=["frontend/fleet-map", "frontend/device-detail", "frontend/tenant-admin", "frontend/accessibility",
                  "edge/api-gateway", "identity/oidc", "billing/usage-ledger", "notifications/webhooks",
                  "reporting/export-worker", "operations/service-worker"],
         features=["cursor-paginated device inventory", "tenant-scoped alarm acknowledgement", "OIDC token refresh",
                   "WCAG keyboard-only navigation", "idempotent usage invoicing", "signed webhook redelivery",
                   "offline device-detail cache", "SSE alarm stream resumption", "CSV export cancellation", "fleet-map viewport clustering"],
         focus="TypeScript UI and Go API gateway for multi-tenant device fleets; OIDC, SSE, accessibility and usage billing",
         extra=("surface", "Product surface", ["desktop", "tablet", "mobile", "api"]),
         states=["discovery", "ready", "in-progress", "in-review", "released"],
         priorities=["backlog", "normal", "high", "critical"], unit="ms"),
    dict(id="harbor-data", name="Harbor server and database services", weight=220, prefix="HDB",
         layout="wide", independent=False, roles=["requirement", "specification", "verification", "bug", "task"],
         modules=["postgres/tenant-partitions", "postgres/schema-migrations", "postgres/query-planner",
                  "ingest/telemetry-batches", "storage/object-manifests", "replication/change-stream",
                  "recovery/pitr", "security/row-policies", "cache/invalidation", "operations/connection-pool"],
         features=["tenant-isolated row-level security", "expand-contract schema migration", "partition-pruning query plan",
                   "idempotent telemetry ingestion", "outbox change-event ordering", "point-in-time restore rehearsal",
                   "object-manifest garbage collection", "bounded connection-pool admission", "read-replica lag fencing", "cursor snapshot consistency"],
         focus="PostgreSQL 16, Go ingestion services and S3-compatible object storage backing Harbor fleet operations",
         extra=("consistency", "Consistency contract", ["eventual", "read-your-writes", "serializable"]),
         states=["draft", "design-reviewed", "implemented", "load-tested", "operational"],
         priorities=["low", "routine", "high", "incident"], unit="ms"),
    dict(id="prism-asic", name="Prism mixed-signal optical sensor", weight=160, prefix="PRSM",
         layout="wide", independent=True, roles=["design-constraint", "specification", "bench-check", "change"],
         modules=["analog/photodiode-tia", "analog/bandgap", "analog/sar-adc", "digital/spi-registers",
                  "digital/clock-domain-crossing", "physical/pad-ring", "physical/power-grid", "board/low-noise-supply",
                  "verification/corner-sweeps", "test/wafer-probe"],
         features=["transimpedance amplifier settling", "12-bit SAR missing-code sweep", "bandgap startup at slow corner",
                   "SPI shadow-register commit", "clock-domain synchronizer coverage", "pad-ring ESD diode leakage",
                   "guard-ring substrate isolation", "LDO power-supply rejection", "scan-chain capture repeatability", "wafer-probe trim retention"],
         focus="180 nm mixed-signal optical sensor ASIC with low-noise PCB, SPICE corner analysis and FPGA register-model validation",
         extra=("corner", "PVT corner", ["tt-25C", "ss-85C", "ff-minus20C", "monte-carlo"]),
         states=["proposed", "simulated", "peer-reviewed", "layout-checked", "silicon-verified"],
         priorities=["enhancement", "minor", "major", "tapeout-blocker"], unit="ns"),
    dict(id="moss-lora", name="Moss low-power woodland telemetry", weight=80, prefix="MOSS",
         layout="flat", independent=False, roles=["requirement", "testcase", "task"],
         modules=["radio", "sleep-clock", "sensor-power", "provisioning", "battery-model", "field-enclosure"],
         features=["LoRaWAN confirmed-uplink backoff", "RTC drift compensation", "sensor-rail leakage budget",
                   "OTAA join nonce persistence", "battery coulomb-counter calibration", "IP67 condensation recovery",
                   "SX1262 TCXO startup", "FRAM sample-ring rollover", "adaptive data-rate floor", "field provisioning QR checksum"],
         focus="STM32L0 and SX1262 battery-powered environmental nodes feeding Tideline gateways",
         extra=("radio_region", "Radio region", ["EU868", "US915", "AU915"]),
         states=["planned", "built", "measured", "deployed"],
         priorities=["optional", "normal", "important", "deployment-blocker"], unit="ms"),
]
ALL_ROLES = list(dict.fromkeys(role for p in PROJECTS for role in p["roles"]))
LABELS = {"requirement": "Requirement", "specification": "Technical specification", "testcase": "Test case",
          "verification": "Verification item", "bug": "Bug", "defect": "Defect", "story": "User story",
          "task": "Engineering task", "component": "Software component", "design-constraint": "Design constraint",
          "bench-check": "Bench characterization", "change": "Design change"}
AUTHORS = ["Ada Chen", "Mira Patel", "Jonas Berg", "Elena Rossi", "Sam Okafor", "Lin Park"]
VERIFICATION = {"testcase", "verification", "bench-check"}
NEEDS = {"requirement", "design-constraint"}
WORK = {"task", "change"}


def arguments():
    parser = argparse.ArgumentParser(description="Seed a varied technical portfolio through Corestone's API.")
    parser.add_argument("url", nargs="?", default="http://127.0.0.1:8080")
    parser.add_argument("--count", type=int, default=1000, help="base number of entries, excluding documents/links/comments")
    parser.add_argument("--scale", type=int, default=1, help="multiply --count; 100 and 1000 target 100k and 1M entries")
    parser.add_argument("--root", default="scale-lab", help="new isolated portfolio folder (must be empty)")
    parser.add_argument("--seed", type=int, default=20261023, help="deterministic content-generation seed")
    parser.add_argument("--dry-run", action="store_true", help="generate and validate the complete workload without contacting the server")
    args = parser.parse_args()
    if args.count < 60 or args.scale < 1:
        parser.error("--count must be at least 60 and --scale must be positive")
    if not args.root or any(not part or part in (".", "..") or not all(c.isascii() and (c.isalnum() or c in "_-.") for c in part) for part in args.root.split("/")):
        parser.error("--root must contain safe, nonempty folder segments")
    if not args.url.startswith(("http://", "https://")):
        parser.error("URL must start with http:// or https://")
    return args


class Client:
    def __init__(self, args):
        self.args = args
        self.api = args.url.rstrip("/") + "/api"
        self.counts = Counter()
        self.projects = Counter()
        self.folders = set()
        self.configs = set()
        self.digest = hashlib.sha256()
        self.started = time.monotonic()

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = Request(self.api + path, data=data, method=method,
                          headers={"Content-Type": "application/json", "X-Corestone-User": "scale-seeder"})
        for attempt in range(41):
            try:
                with urlopen(request, timeout=180) as response:
                    return json.load(response)
            except HTTPError as error:
                detail = error.read().decode(errors="replace")
                if error.code == 503 and error.headers.get("Retry-After") and attempt < 40:
                    delay = min(10, max(1, int(error.headers.get("Retry-After", "1"))))
                    print(f"Maintenance: retrying {method} {path} in {delay}s", file=sys.stderr)
                    time.sleep(delay)
                    continue
                raise RuntimeError(f"{method} {path}: HTTP {error.code}: {detail}") from error
            except URLError as error:
                raise RuntimeError(f"{method} {path}: {error.reason}; writes are not retried because the outcome may be ambiguous") from error
        raise RuntimeError(f"Maintenance retry limit reached for {method} {path}")

    def record(self, kind, path, body):
        self.digest.update(json.dumps([kind, path, body], sort_keys=True, separators=(",", ":")).encode())
        self.counts[kind] += 1

    def config(self, scope, path, body):
        key = (scope, path)
        if key in self.configs:
            raise RuntimeError(f"Duplicate configuration write: {key}")
        self.configs.add(key)
        self.record("configs", scope + "/" + path, body)
        if not self.args.dry_run:
            self.request("PUT", "/config?" + urlencode(dict(scope=scope, path=path)), body)

    def create(self, kind, body):
        self.record(kind, body.get("path", ""), body)
        if "path" in body:
            self.folders.add(body["path"])
        if self.args.dry_run:
            return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{kind}:{self.counts[kind]}"))
        result = self.request("POST", "/" + kind, body)
        guid = result.get("meta", {}).get("guid")
        if not guid:
            raise RuntimeError(f"POST /{kind}: response missing meta.guid")
        return guid

    def link(self, kind, source, target):
        if source == target:
            raise RuntimeError(f"Refusing self-link {kind}: {source}")
        self.create("links", dict(type=kind, source=source, target=target))

    def advance(self, guid, workflow, depth):
        for index in range(depth):
            body = dict(workflow=workflow, to=f"advance-{index}")
            self.record("transitions", guid, body)
            if not self.args.dry_run:
                self.request("POST", f"/artifacts/{guid}/transition", body)


def enumeration(values):
    colors = ["#667085", "#3b82f6", "#d97706", "#dc2626"]
    return {"options": [dict(value=value, label=value.replace("-", " ").title(), color=colors[i % len(colors)]) for i, value in enumerate(values)]}


def workflow(states):
    return dict(initial=states[0], states=[dict(id=s, name=s.replace("-", " ").title(), final=i == len(states) - 1) for i, s in enumerate(states)],
                transitions=[dict(id=f"advance-{i}", name=f"Accept {states[i + 1]}", **{"from": [states[i]], "to": states[i + 1]}) for i in range(len(states) - 1)])


def common_fields():
    return [dict(id="priority", name="Priority", type="enum", enum="priority"),
            dict(id="effort", name="Effort (days)", type="integer"),
            dict(id="description", name="Engineering detail", type="multiline"),
            dict(id="tags", name="Tags", type="enum", enum="tags", multiple=True),
            dict(id="owner", name="Owner", type="text"),
            dict(id="iteration", name="Iteration", type="integer"),
            dict(id="due", name="Target date", type="date")]


def type_defs(roles, prefix, workflow_id):
    return [dict(id=role, displayName=LABELS[role], hid=dict(prefix=f"{prefix}-{role[:3].upper()}", digits=6),
                 workflows=[workflow_id], fields=[dict(id="priority", required=True), "effort", "description", "tags", "owner", "iteration", "due"],
                 presentation=dict(columns=["priority", "effort", "owner", "iteration"])) for role in roles]


def configure(client):
    root = client.args.root
    cfg = client.config
    cfg(root, "entries/enums/priority-enum.json", enumeration(["low", "medium", "high", "urgent"]))
    cfg(root, "entries/enums/tags-enum.json", dict(extendable=True, options=[dict(value=s) for s in ["architecture", "reliability", "performance", "verification", "documentation"]]))
    cfg(root, "entries/fields.json", dict(fields=common_fields()))
    cfg(root, "entries/workflows/delivery-workflow.json", workflow(["open", "implementation", "verification", "done"]))
    cfg(root, "entries/types.json", dict(inheritance="off", types=type_defs(ALL_ROLES, "LAB", "delivery")))
    cfg(root, "documents/workflows/publication-workflow.json", workflow(["draft", "review", "released"]))
    cfg(root, "documents/types.json", dict(inheritance="off", types=[dict(id=s, displayName=n, hid=dict(prefix=p), workflows=["publication"])
        for s, n, p in [("architecture-note", "Architecture note", "ARCH"), ("verification-plan", "Verification plan", "VPLAN"), ("interface-contract", "Interface contract", "IFACE")]]))
    cfg(root, "links/types.json", dict(inheritance="off", types=[dict(id=s, displayName=n) for s, n in [
        ("verifies", "verifies"), ("refines", "refines"), ("implements", "implements"), ("affects", "affects"),
        ("fixes", "fixes"), ("blocks", "blocks"), ("depends-on", "depends on"), ("exposes", "exposes API to"), ("documents", "documents")]]))
    cfg(root, "comments/types.json", dict(inheritance="off", types=[dict(id="engineering-note", displayName="Engineering note"), dict(id="review-question", displayName="Review question")]))
    for p in PROJECTS:
        scope = root + "/" + p["id"]
        cfg(scope, "entries/enums/priority-enum.json", enumeration(p["priorities"]))
        extra_id, extra_name, extra_values = p["extra"]
        cfg(scope, f"entries/enums/{extra_id}-enum.json", enumeration(extra_values))
        fields = common_fields() if p["independent"] else []
        fields.append(dict(id=extra_id, name=extra_name, type="enum", enum=extra_id))
        cfg(scope, "entries/fields.json", dict(fields=fields))
        if p["independent"]:
            cfg(scope, "entries/enums/tags-enum.json", dict(extendable=True, options=[dict(value=m) for m in p["modules"]]))
        cfg(scope, "entries/workflows/delivery-workflow.json", workflow(p["states"]))
        types = type_defs(p["roles"], p["prefix"], "delivery")
        for t in types:
            t["fields"].append(extra_id)
            t["presentation"]["columns"].append(extra_id)
        cfg(scope, "entries/types.json", dict(**({"inheritance": "off"} if p["independent"] else {}), types=types))
        if p["id"] == "moss-lora":
            cfg(scope, "documents/types.json", dict(inheritance="off", types=[]))
            cfg(scope, "comments/types.json", dict(inheritance="off", types=[]))
        if p["layout"] == "wide":
            for index, module in enumerate(p["modules"]):
                child = scope + "/" + module
                cfg(child, f"entries/{p['roles'][0]}-fields.json", dict(fields=[
                    dict(id="budget", name=f"Acceptance budget ({p['unit']})", type="float"),
                    dict(id="measurement", name="Measurement method", type="text")]))
                # Same option values, deliberately different sequence: exercise scoped enum sorting.
                ordered = p["priorities"][index % 4:] + p["priorities"][:index % 4]
                cfg(child, "entries/enums/priority-enum.json", enumeration(ordered))


def text_for(p, role, feature, module, variant, budget):
    context = f"{p['focus']}. Subsystem: {module}; hardware/API revision {variant}."
    acceptance = f"Acceptance: complete {feature} within {budget} {p['unit']} at the documented worst-case load; preserve diagnostic evidence across restart."
    if role in NEEDS:
        return f"Bound {feature} latency", f"The subsystem shall bound {feature} latency to {budget} {p['unit']}. {context}\n{acceptance}"
    if role == "specification":
        return f"Specify {feature} interface and failure behavior", f"Define preconditions, state ownership, timeout handling and recovery for {feature}. {context}\n{acceptance}"
    if role in VERIFICATION:
        return f"Verify {feature} across restart and load corners", f"1. Provision revision {variant}.\n2. Exercise {feature} with fault injection.\n3. Capture timing, resource use and recovery traces.\n4. Compare against {budget} {p['unit']} acceptance budget. {context}"
    if role in {"bug", "defect"}:
        return f"{feature.capitalize()} loses recovery evidence after restart", f"Reproduce: interrupt {feature} between persistence and acknowledgement, then restart. Expected: deterministic replay and retained diagnostics. Observed: the recovery marker is stale on revision {variant}. {context}"
    if role == "story":
        return f"Inspect {feature} without losing tenant context", f"As a fleet operator, I want to inspect {feature} within the selected tenant so that I can diagnose degraded devices without cross-tenant data exposure. {context}\n{acceptance}"
    if role == "component":
        return f"{feature.capitalize()} adapter", f"Owns {feature} boundary conversion, cancellation and diagnostic counters. Exposes an explicit failure result; no implicit retries after an ambiguous acknowledgement. {context}"
    return f"Implement {feature} recovery and instrumentation", f"Implement bounded retries, persistent recovery markers and structured metrics for {feature}; add the linked regression evidence and update the interface notes. {context}\n{acceptance}"


def document(client, p, module, refs, index):
    scope = client.args.root + "/" + p["id"]
    path = scope if p["layout"] == "flat" else scope + "/" + module + "/design/reviews"
    for dtype, label in [("architecture-note", "Design rationale"), ("verification-plan", "Verification matrix")]:
        content = [dict(id="overview", type="section", title=label, children=[
            dict(id="context", type="paragraph", text=p["focus"] + ". The linked artifacts define the current acceptance baseline."),
            *[dict(id=f"entry-{i}", type="entry", guid=guid) for i, guid in enumerate(refs)],
            dict(id="checks", type="list", items=[dict(id="timing", type="paragraph", text="Record timing at nominal and worst-case resource pressure."),
                dict(id="recovery", type="paragraph", text="Verify recovery after reset, partial writes and interrupted communication.")])])]
        guid = client.create("documents", dict(path=path, type=dtype, title=f"{p['name']} / {module} / {label}", content=content))
        for ref in refs[:3]:
            client.link("documents", guid, ref)
        if index % 2 == 0:
            client.advance(guid, "publication", 1 + (index // 2) % 2)


def generate(client):
    rng = random.Random(client.args.seed)
    total = client.args.count * client.args.scale
    allocations = [total * p["weight"] // 1000 for p in PROJECTS]
    for index in range(total - sum(allocations)):
        allocations[index % len(PROJECTS)] += 1
    anchors = {}
    for p, amount in zip(PROJECTS, allocations):
        module_refs = {}
        role_anchors = {}
        last_work = None
        roles = p["roles"]
        for index in range(amount):
            bundle, role_index = divmod(index, len(roles))
            module_index = bundle % len(p["modules"])
            module = p["modules"][module_index]
            feature = p["features"][bundle % len(p["features"]) ]
            variant = 1 + bundle // len(p["features"])
            role = roles[role_index]
            path = client.args.root + "/" + p["id"]
            if p["layout"] == "wide":
                path += "/" + module
                if bundle >= len(p["modules"]):
                    path += f"/releases/r{1 + bundle // (len(p['modules']) * 4):03d}/variant-{variant:04d}"
            budget = rng.choice([2, 5, 10, 25, 50, 100, 250])
            title, description = text_for(p, role, feature, module, variant, budget)
            fields = dict(priority=p["priorities"][rng.randrange(4)], effort=rng.choice([1, 2, 3, 5, 8, 13]),
                          description=description, tags=[module, rng.choice(["performance", "reliability", "verification"])],
                          owner=AUTHORS[(bundle + role_index) % len(AUTHORS)], iteration=1 + bundle // 4,
                          due=str(date(2027, 1, 4) + timedelta(days=bundle % 350)))
            fields[p["extra"][0]] = rng.choice(p["extra"][2])
            if p["layout"] == "wide" and role == roles[0]:
                fields.update(budget=float(budget), measurement=f"Instrument {module}; collect 1000 samples plus cold-start and restart traces")
            guid = client.create("entries", dict(path=path, type=role, title=f"{title} [{module}, rev {variant}]", fields=fields))
            client.projects[p["id"]] += 1
            if role_index == 0:
                role_anchors = {}
            need = next((role_anchors[r] for r in roles if r in NEEDS and r in role_anchors), None)
            spec = role_anchors.get("specification")
            bug = role_anchors.get("bug") or role_anchors.get("defect")
            if role in VERIFICATION and (need or spec):
                client.link("verifies", guid, need or spec)
                if spec and spec != need:
                    client.link("verifies", guid, spec)
            elif role == "specification" and need:
                client.link("refines", guid, need)
            elif role in {"bug", "defect"} and need:
                client.link("affects", guid, need)
            elif role in WORK:
                if bug:
                    client.link("fixes", guid, bug)
                if need:
                    client.link("implements", guid, need)
                if last_work:
                    client.link("blocks", last_work, guid)
                last_work = guid
            elif role == "component" and need:
                client.link("implements", guid, need)
            elif role in NEEDS and "story" in role_anchors:
                client.link("refines", guid, role_anchors["story"])
            role_anchors[role] = guid
            anchors.setdefault(p["id"], {}).setdefault(role, guid)
            module_refs.setdefault(module, [])
            if len(module_refs[module]) < len(roles):
                module_refs[module].append(guid)
            # Distribute lifecycle states without a transition commit for every artifact.
            if index % 4 == 0:
                client.advance(guid, "delivery", 1 + (index // 4) % (len(p["states"]) - 1))
            if p["id"] != "moss-lora" and index % 17 == 0:
                comment = client.create("comments", dict(type="review-question", subject=guid, author=AUTHORS[module_index % len(AUTHORS)],
                    text=f"For {feature}, please attach the worst-case {budget} {p['unit']} timing trace and the restart-recovery evidence before acceptance."))
                client.create("comments", dict(type="engineering-note", subject=guid, parent=comment, author=AUTHORS[(module_index + 1) % len(AUTHORS)],
                    text=f"Agreed. The {module} verification matrix covers the nominal, saturation and interrupted-write cases; rerun on revision {variant}."))
            if client.counts["entries"] % 100 == 0:
                elapsed = time.monotonic() - client.started
                print(f"Entries {client.counts['entries']}/{total}; {elapsed:.1f}s; {p['id']}", file=sys.stderr, flush=True)
        if p["id"] != "moss-lora":
            for index, (module, refs) in enumerate(module_refs.items()):
                document(client, p, module, refs, index)
        print(f"Completed {p['name']}: {amount} entries", file=sys.stderr, flush=True)
    # Cross-project dependencies: user-facing behavior backed by real service/storage contracts.
    client.link("depends-on", anchors["harbor-web"]["requirement"], anchors["harbor-data"]["requirement"])
    client.link("exposes", anchors["harbor-data"]["specification"], anchors["harbor-web"]["component"])
    client.link("verifies", anchors["harbor-web"]["testcase"], anchors["harbor-data"]["specification"])
    client.link("depends-on", anchors["tideline-pi"]["component"], anchors["prism-asic"]["specification"])
    client.link("depends-on", anchors["moss-lora"]["requirement"], anchors["tideline-pi"]["requirement"])
    client.link("depends-on", anchors["harbor-data"]["requirement"], anchors["tideline-pi"]["specification"])
    client.link("depends-on", anchors["verdant-mcu"]["requirement"], anchors["prism-asic"]["design-constraint"])
    contract = client.create("documents", dict(path=client.args.root + "/harbor-data/contracts", type="interface-contract",
        title="Harbor web/server contract: tenant isolation, telemetry ingestion and cursor semantics",
        content=[dict(id="contract", type="section", title="Versioned service boundary", children=[
            dict(id="overview", type="paragraph", text="The web gateway sends a tenant-scoped idempotency key with every telemetry write. PostgreSQL row policies enforce tenant isolation. Cursor tokens bind the tenant, filter digest and stable ordering key; expired snapshots return an explicit conflict."),
            dict(id="web", type="entry", guid=anchors["harbor-web"]["requirement"]),
            dict(id="data", type="entry", guid=anchors["harbor-data"]["specification"]),
            dict(id="verify", type="entry", guid=anchors["harbor-web"]["testcase"])])]))
    client.link("documents", contract, anchors["harbor-data"]["specification"])
    client.link("documents", contract, anchors["harbor-web"]["requirement"])
    if client.counts["entries"] != total or sum(client.projects.values()) != total:
        raise RuntimeError("Generated entry count does not match requested total")


def main():
    args = arguments()
    client = Client(args)
    if not args.dry_run:
        client.request("GET", "/health")
        existing = client.request("GET", "/repository/tree?" + urlencode(dict(path=args.root, subtree="true", limit=1)))
        if existing.get("artifacts") or existing.get("folders") or existing.get("total", 0):
            raise RuntimeError(f"Refusing to seed populated folder {args.root!r}; choose a new --root. Partial runs are not resumed.")
        # A config-only scope is also occupied: do not overwrite existing definitions.
        listing = client.request("GET", "/config?all=true")
        if any(item["scope"] == args.root or item["scope"].startswith(args.root + "/") for item in listing.get("files", [])):
            raise RuntimeError(f"Refusing to overwrite existing configuration in {args.root!r}")
    configure(client)
    generate(client)
    elapsed = time.monotonic() - client.started
    if not args.dry_run:
        for collection, kind in [("entries", "entry"), ("documents", "document"), ("links", "link"), ("comments", "comment")]:
            result = client.request("GET", "/repository/search?" + urlencode(dict(path=args.root, subtree="true", kind=kind, limit=1)))
            if result.get("total") != client.counts[collection]:
                raise RuntimeError(f"Persisted {collection} count mismatch: expected {client.counts[collection]}, API returned {result.get('total')}")
        listing = client.request("GET", "/config?all=true")
        configs = [item for item in listing.get("files", []) if item["scope"] == args.root or item["scope"].startswith(args.root + "/")]
        invalid = [item for item in configs if not item["valid"]]
        if invalid or len(configs) != client.counts["configs"]:
            raise RuntimeError(f"Configuration verification failed: expected {client.counts['configs']} valid files, got {len(configs)} files; invalid: {invalid}")
    summary = dict(mode="dry-run" if args.dry_run else "persisted", root=args.root, seed=args.seed,
                   counts=dict(client.counts), projects=dict(client.projects), artifact_folders=len(client.folders),
                   configuration_scopes=len({scope for scope, _ in client.configs}),
                   workload_sha256=client.digest.hexdigest(), elapsed_seconds=round(elapsed, 2))
    print(json.dumps(summary, indent=2))
    if not args.dry_run:
        print(f"Open {args.url.rstrip('/')}/folder/{args.root}?subtree=1", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, TimeoutError, ValueError) as error:
        print(f"Seeding failed: {error}", file=sys.stderr)
        sys.exit(1)
PY

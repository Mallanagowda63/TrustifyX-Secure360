// TEST FIXTURE — stands in for `zap.sh -cmd -autorun <plan>` so the scan runner can be tested
// without ZAP. It reads the generated plan, sends requests through the plan's proxy (in scope and
// out of scope), prints Automation Framework-style progress lines and writes a report shaped like
// ZAP's traditional JSON report. It is NOT OWASP ZAP and proves nothing about ZAP itself.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const planPath = process.argv[process.argv.length - 1];
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const mode = process.env.FAKE_ZAP_MODE ?? "ok";
const proxyPort = plan.env.proxy.port;
const target = new URL(plan.env.contexts[0].urls[0]);
const report = plan.jobs.find((j) => j.type === "report").parameters;

function viaProxy(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: u.host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

console.log("Job spider started");
const inScope = await viaProxy(`http://${target.host}/`);
const outOfScope = await viaProxy(`http://evil-cdn.example:${target.port || 80}/x.js`);
console.log(`Job spider finished (in-scope ${inScope}, out-of-scope ${outOfScope})`);
console.log("Job passiveScan-wait started");
if (mode === "hang") await new Promise((r) => setTimeout(r, 60_000));
if (mode === "noreport") process.exit(1);
console.log("Job report started");

const host = target.hostname;
fs.writeFileSync(
  path.join(report.reportDir, `${report.reportFile}.json`),
  JSON.stringify({
    "@programName": "ZAP",
    site: [
      {
        "@name": `https://${host}`,
        "@host": host,
        "@port": "443",
        "@ssl": "true",
        alerts: [
          {
            pluginid: "10038", alertRef: "10038-1", alert: "Content Security Policy (CSP) Header Not Set", name: "Content Security Policy (CSP) Header Not Set",
            riskcode: "2", confidence: "3", riskdesc: "Medium (High)", desc: "<p>Content Security Policy (CSP) is an added layer of security.</p>",
            instances: [{ uri: `https://${host}/`, method: "GET", param: "", attack: "", evidence: "" }, { uri: "https://cdn.other.example/a.js", method: "GET" }],
            count: "2", solution: "<p>Ensure that your web server sets the Content-Security-Policy header.</p>", reference: "<p>https://developer.mozilla.org/</p>", cweid: "693", wascid: "15", sourceid: "1",
          },
          {
            pluginid: "10021", alertRef: "10021", alert: "X-Content-Type-Options Header Missing", riskcode: "1", confidence: "2", desc: "<p>The Anti-MIME-Sniffing header is not set.</p>",
            instances: [{ uri: `https://${host}/app.js`, method: "GET", evidence: "" }], count: "1", solution: "<p>Set X-Content-Type-Options: nosniff.</p>", cweid: "693", wascid: "15",
          },
        ],
      },
      { "@name": "https://third-party.example", "@host": "third-party.example", alerts: [{ pluginid: "1", alert: "Off target", riskcode: "3", confidence: "3", instances: [] }] },
    ],
  }),
);
console.log("Job report finished");
process.exit(0);

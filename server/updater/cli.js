// Backups from the server's shell, inside the updater container
// (scripts/office3d-backup.sh runs this). Talks to the updater service on
// loopback, the only place a restore is accepted from.
//
//   node server/updater/cli.js list
//   node server/updater/cli.js now
//   node server/updater/cli.js restore <id>

const base = `http://127.0.0.1:${process.env.UPDATER_PORT || 3020}`;
const headers = { Authorization: `Bearer ${process.env.OFFICE3D_UPDATER_TOKEN ?? ""}` };

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

const status = async () => {
  const response = await fetch(`${base}/backups`, { headers });
  if (!response.ok) throw new Error(`updater answered ${response.status}`);
  return response.json();
};

const main = async () => {
  const [command, id] = process.argv.slice(2);
  if (command === "list") {
    const current = await status();
    const schedule = current.schedule ? `daily at ${current.schedule.time} ${current.schedule.timeZone}, keeping ${current.schedule.keep}` : "off";
    console.log(`Schedule: ${schedule}`);
    if (current.last) console.log(`Last run: ${current.last.id} — ${current.last.status}${current.last.errors?.length ? ` (${current.last.errors.join("; ")})` : ""}`);
    if (!current.backups.length) console.log("No backups yet.");
    for (const entry of current.backups) {
      console.log(`${entry.id}  ${entry.complete ? "complete  " : "INCOMPLETE"}  Hermes ${entry.hermesTag ?? "?"}  ${size(entry.size)}`);
    }
    return;
  }
  if (command === "now") {
    const before = await status();
    const response = await fetch(`${base}/backups`, { method: "POST", headers });
    if (response.status !== 202) throw new Error((await response.json().catch(() => ({}))).error ?? `updater answered ${response.status}`);
    process.stdout.write("Backing up");
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = await status();
      if (!current.running && current.last?.id !== before.last?.id) {
        console.log(`\n${current.last.id}: ${current.last.status}${current.last.errors?.length ? ` — ${current.last.errors.join("; ")}` : ""}`);
        process.exitCode = current.last.status === "failed" ? 1 : 0;
        return;
      }
      process.stdout.write(".");
    }
  }
  if (command === "restore" && id) {
    const response = await fetch(`${base}/backups/${encodeURIComponent(id)}/restore`, { method: "POST", headers });
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error ?? `updater answered ${response.status}`);
    let text = "";
    for await (const chunk of response.body) {
      const piece = Buffer.from(chunk).toString("utf8");
      text += piece;
      process.stdout.write(piece);
    }
    process.exitCode = text.includes("\nOK:") || text.startsWith("OK:") ? 0 : 1;
    return;
  }
  console.error("Usage: list | now | restore <id>");
  process.exitCode = 2;
};

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});

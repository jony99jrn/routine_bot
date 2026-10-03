// api/telegram.js — Telegram webhook for the class routine bot
// Env vars needed on Vercel: BOT_TOKEN, SHEET_CSV_URL
// Sheet columns (row 1): Section | Day | Start | End | Time | Course | Teacher | Room

const TZ = "Asia/Dhaka";

// Small CSV parser (handles quoted cells)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function loadRoutine() {
  const res = await fetch(process.env.SHEET_CSV_URL);
  const rows = parseCSV(await res.text());
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r.some((x) => x.trim()))
    .map((r) =>
      Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()]))
    );
}

// Weekday name in Dhaka time, offsetDays = 0 (today) or 1 (tomorrow)
function dayName(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TZ }).format(d);
}

function classesFor(rows, section, day) {
  const short = day.slice(0, 3).toLowerCase();
  return rows.filter(
    (r) =>
      (r.section || "").toLowerCase() === section.toLowerCase() &&
      (r.day || "").toLowerCase().startsWith(short)
  );
}

function formatReply(title, section, day, list) {
  if (!list.length) return `${title} · ${section}\n${day}: No classes.`;
  const lines = list.map((c) => {
    // Use the Time column if filled, otherwise Start–End
    const when = c.time || [c.start, c.end].filter(Boolean).join("–");
    const extra = [c.teacher, c.room ? "Room " + c.room : ""].filter(Boolean).join(", ");
    return `${when}  ${c.course}${extra ? " (" + extra + ")" : ""}`;
  });
  return `${title} · ${section}\n${day}\n\n${lines.join("\n")}`;
}

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");

  const msg = req.body && req.body.message;
  if (!msg || !msg.text) return res.status(200).send("ok");

  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const section = args[0];

  let reply;
  try {
    if (cmd === "/start") {
      reply =
        "Routine Bot\n\n" +
        "/today 72_S — today's classes\n" +
        "/tomorrow 72_S — tomorrow's classes";
    } else if (cmd === "/today" || cmd === "/tomorrow") {
      if (!section) {
        reply = `Send it like: ${cmd} 72_S`;
      } else {
        const isToday = cmd === "/today";
        const day = dayName(isToday ? 0 : 1);
        const rows = await loadRoutine();
        reply = formatReply(
          isToday ? "TODAY'S CLASSES" : "TOMORROW'S CLASSES",
          section,
          day,
          classesFor(rows, section, day)
        );
      }
    } else {
      reply = "Unknown command. Try /today 72_S";
    }
  } catch (e) {
    reply = "Something went wrong. Please try again later.";
  }

  await send(msg.chat.id, reply);
  res.status(200).send("ok");
};

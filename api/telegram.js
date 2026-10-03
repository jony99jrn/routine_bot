// api/telegram.js — Class routine bot with button menus
// Env vars on Vercel: BOT_TOKEN, SHEET_CSV_URL
// Sheet columns (row 1): Section | Day | Start | End | Time | Course | Teacher | Room

const TZ = "Asia/Dhaka";
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"];
const WELCOME =
  "📚 Class Routine Bot\n\nSee your class routine for any day.\nPick your section below to start.";

// ---------- Sheet reading ----------
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

async function getSections() {
  const rows = await loadRoutine();
  return [...new Set(rows.map((r) => r.section).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

// ---------- Helpers ----------
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
    const when = c.time || [c.start, c.end].filter(Boolean).join("–");
    const extra = [c.teacher, c.room ? "Room " + c.room : ""].filter(Boolean).join(", ");
    return `${when}  ${c.course}${extra ? " (" + extra + ")" : ""}`;
  });
  return `${title} · ${section}\n${day}\n\n${lines.join("\n")}`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------- Keyboards ----------
function sectionKeyboard(sections) {
  const buttons = sections.map((s) => ({ text: s, callback_data: "s:" + s }));
  return { inline_keyboard: chunk(buttons, 4) };
}

function dayKeyboard(section) {
  const quick = [
    { text: "Today", callback_data: `d:${section}:today` },
    { text: "Tomorrow", callback_data: `d:${section}:tomorrow` },
  ];
  const days = WEEK.map((d) => ({ text: d, callback_data: `d:${section}:${d}` }));
  return {
    inline_keyboard: [quick, ...chunk(days, 2), [{ text: "⬅ Sections", callback_data: "sec" }]],
  };
}

function backKeyboard(section) {
  return {
    inline_keyboard: [
      [
        { text: "⬅ Days", callback_data: "s:" + section },
        { text: "Sections", callback_data: "sec" },
      ],
    ],
  };
}

// ---------- Telegram ----------
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function sendSectionMenu(chatId) {
  const sections = await getSections();
  if (!sections.length) {
    return tg("sendMessage", { chat_id: chatId, text: "No sections found in the sheet yet." });
  }
  return tg("sendMessage", {
    chat_id: chatId,
    text: WELCOME,
    reply_markup: sectionKeyboard(sections),
  });
}

async function handleMessage(msg) {
  const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const chatId = msg.chat.id;

  // Quick commands still work: /today 72_S and /tomorrow 72_S
  if ((cmd === "/today" || cmd === "/tomorrow") && args[0]) {
    const day = dayName(cmd === "/today" ? 0 : 1);
    const rows = await loadRoutine();
    const text = formatReply(
      cmd === "/today" ? "TODAY'S CLASSES" : "TOMORROW'S CLASSES",
      args[0],
      day,
      classesFor(rows, args[0], day)
    );
    return tg("sendMessage", { chat_id: chatId, text });
  }

  // /start, /sections, or anything else → show the section menu
  return sendSectionMenu(chatId);
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || "";

  await tg("answerCallbackQuery", { callback_query_id: cq.id });

  let text;
  let markup;

  if (data === "sec") {
    text = WELCOME;
    markup = sectionKeyboard(await getSections());
  } else if (data.startsWith("s:")) {
    const section = data.slice(2);
    text = `Section ${section}\n\nChoose a day:`;
    markup = dayKeyboard(section);
  } else if (data.startsWith("d:")) {
    const [, section, which] = data.split(":");
    const day =
      which === "today" ? dayName(0) : which === "tomorrow" ? dayName(1) : which;
    const rows = await loadRoutine();
    text = formatReply("📅 CLASSES", section, day, classesFor(rows, section, day));
    markup = backKeyboard(section);
  } else {
    return;
  }

  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: markup,
  });
}

// ---------- Entry point ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");
  const body = req.body || {};
  try {
    if (body.callback_query) await handleCallback(body.callback_query);
    else if (body.message && body.message.text) await handleMessage(body.message);
  } catch (e) {
    console.error(e);
  }
  res.status(200).send("ok");
};

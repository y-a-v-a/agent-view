const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const HOME = require("os").homedir();

const SOURCES = {
  pi: {
    dir: path.join(HOME, ".pi", "agent"),
    sessionsDir: path.join(HOME, ".pi", "agent", "sessions"),
    label: "pi",
  },
  claude: {
    dir: path.join(HOME, ".claude"),
    sessionsDir: path.join(HOME, ".claude", "projects"),
    label: "Claude Code",
  },
};

// Approximate cost per token for Claude Sonnet 4.5 (used when cost not provided)
const TOKEN_COSTS = {
  input: 3.0 / 1_000_000,
  output: 15.0 / 1_000_000,
  cacheRead: 0.30 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
};

app.use(express.static(path.join(__dirname, "public")));

// Extract project name from encoded directory name
// e.g. "--Users-vincentb-Sites-got--" -> "got"
// e.g. "-Users-vincentb-Sites-openclaw-channel-cqlaw" -> "openclaw-channel-cqlaw"
function projectNameFromDir(dirName) {
  const cleaned = dirName.replace(/^-+/, "").replace(/-+$/, "");
  const parts = cleaned.split("-");
  const sitesIdx = parts.lastIndexOf("Sites");
  if (sitesIdx >= 0 && sitesIdx < parts.length - 1) {
    return parts.slice(sitesIdx + 1).join("-");
  }
  return parts[parts.length - 1];
}

function parsePiSessions() {
  const sessionsDir = SOURCES.pi.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return [];

  const sessions = [];
  for (const projectDir of fs.readdirSync(sessionsDir)) {
    const projectPath = path.join(sessionsDir, projectDir);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const projectName = projectNameFromDir(projectDir);
    const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const lines = fs.readFileSync(path.join(projectPath, file), "utf8").trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const sessionEvent = events.find((e) => e.type === "session");
      const messages = events.filter((e) => e.type === "message");
      const modelChanges = events.filter((e) => e.type === "model_change");
      const thinkingChanges = events.filter((e) => e.type === "thinking_level_change");

      const userMessages = messages.filter((m) => m.message.role === "user");
      const assistantMessages = messages.filter((m) => m.message.role === "assistant");
      const toolResults = messages.filter((m) => m.message.role === "toolResult");

      const totalCost = assistantMessages.reduce((sum, m) => sum + (m.message.usage?.cost?.total || 0), 0);
      const totalInputTokens = assistantMessages.reduce((sum, m) => sum + (m.message.usage?.input || 0), 0);
      const totalOutputTokens = assistantMessages.reduce((sum, m) => sum + (m.message.usage?.output || 0), 0);
      const totalCacheRead = assistantMessages.reduce((sum, m) => sum + (m.message.usage?.cacheRead || 0), 0);
      const totalCacheWrite = assistantMessages.reduce((sum, m) => sum + (m.message.usage?.cacheWrite || 0), 0);

      const timestamps = messages.map((m) => new Date(m.timestamp));
      const startTime = timestamps.length ? new Date(Math.min(...timestamps)) : null;
      const endTime = timestamps.length ? new Date(Math.max(...timestamps)) : null;
      const durationMinutes = startTime && endTime ? (endTime - startTime) / 60000 : 0;

      const models = [...new Set(modelChanges.map((m) => m.modelId))];
      const thinkingLevels = [...new Set(thinkingChanges.map((t) => t.thinkingLevel))];

      sessions.push({
        project: projectName,
        startTime: sessionEvent?.timestamp || null,
        messages: { total: messages.length, user: userMessages.length, assistant: assistantMessages.length, toolResult: toolResults.length },
        cost: totalCost,
        tokens: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
        durationMinutes,
        models,
        thinkingLevels,
        userMessageTimestamps: userMessages.map((m) => m.timestamp),
      });
    }
  }
  return sessions;
}

function parseClaudeSessions() {
  const sessionsDir = SOURCES.claude.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return [];

  const sessions = [];
  for (const projectDir of fs.readdirSync(sessionsDir)) {
    const projectPath = path.join(sessionsDir, projectDir);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const projectName = projectNameFromDir(projectDir);
    const files = fs.readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const lines = fs.readFileSync(path.join(projectPath, file), "utf8").trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      // Filter real user messages (not meta, not commands)
      const userMessages = events.filter(
        (e) => e.type === "user" && !e.isMeta && !e.message?.content?.toString().includes("<command-name>") && !e.message?.content?.toString().includes("<local-command-stdout>")
      );
      const assistantMessages = events.filter((e) => e.type === "assistant" && !e.isApiErrorMessage);

      // Extract tokens and estimate cost from assistant messages
      let totalInputTokens = 0,
        totalOutputTokens = 0,
        totalCacheRead = 0,
        totalCacheWrite = 0;
      const models = new Set();

      for (const a of assistantMessages) {
        const usage = a.message?.usage;
        if (usage) {
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheWrite += usage.cache_creation_input_tokens || 0;
        }
        if (a.message?.model) models.add(a.message.model);
      }

      const estimatedCost =
        totalInputTokens * TOKEN_COSTS.input +
        totalOutputTokens * TOKEN_COSTS.output +
        totalCacheRead * TOKEN_COSTS.cacheRead +
        totalCacheWrite * TOKEN_COSTS.cacheWrite;

      const timestamps = events.filter((e) => e.timestamp).map((e) => new Date(e.timestamp));
      const startTime = timestamps.length ? new Date(Math.min(...timestamps)) : null;
      const endTime = timestamps.length ? new Date(Math.max(...timestamps)) : null;
      const durationMinutes = startTime && endTime ? (endTime - startTime) / 60000 : 0;

      sessions.push({
        project: projectName,
        startTime: startTime?.toISOString() || null,
        messages: { total: events.length, user: userMessages.length, assistant: assistantMessages.length, toolResult: 0 },
        cost: estimatedCost,
        tokens: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
        durationMinutes,
        models: [...models],
        thinkingLevels: [],
        userMessageTimestamps: userMessages.map((m) => m.timestamp),
      });
    }
  }
  return sessions;
}

function buildStats(sessions) {
  const punchcard = Array.from({ length: 7 }, () => Array(24).fill(0));
  const dailyActivity = {};
  const dailyCost = {};
  const dailyTokens = {};
  const projectStats = {};
  const modelUsage = {};
  const thinkingUsage = {};

  for (const session of sessions) {
    if (!projectStats[session.project]) {
      projectStats[session.project] = {
        sessions: 0,
        messages: 0,
        userMessages: 0,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        durationMinutes: 0,
      };
    }
    const ps = projectStats[session.project];
    ps.sessions++;
    ps.messages += session.messages.total;
    ps.userMessages += session.messages.user;
    ps.cost += session.cost;
    ps.tokens.input += session.tokens.input;
    ps.tokens.output += session.tokens.output;
    ps.tokens.cacheRead += session.tokens.cacheRead;
    ps.tokens.cacheWrite += session.tokens.cacheWrite;
    ps.durationMinutes += session.durationMinutes;

    for (const m of session.models) modelUsage[m] = (modelUsage[m] || 0) + 1;
    for (const t of session.thinkingLevels) thinkingUsage[t] = (thinkingUsage[t] || 0) + 1;

    for (const ts of session.userMessageTimestamps) {
      const d = new Date(ts);
      punchcard[d.getDay()][d.getHours()]++;
      const dayKey = ts.substring(0, 10);
      dailyActivity[dayKey] = (dailyActivity[dayKey] || 0) + 1;
    }

    if (session.startTime) {
      const dayKey = session.startTime.substring(0, 10);
      dailyCost[dayKey] = (dailyCost[dayKey] || 0) + session.cost;
      if (!dailyTokens[dayKey]) dailyTokens[dayKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      dailyTokens[dayKey].input += session.tokens.input;
      dailyTokens[dayKey].output += session.tokens.output;
      dailyTokens[dayKey].cacheRead += session.tokens.cacheRead;
      dailyTokens[dayKey].cacheWrite += session.tokens.cacheWrite;
    }
  }

  const totalCost = sessions.reduce((s, sess) => s + sess.cost, 0);
  const totalMessages = sessions.reduce((s, sess) => s + sess.messages.total, 0);
  const totalUserMessages = sessions.reduce((s, sess) => s + sess.messages.user, 0);
  const totalDurationMinutes = sessions.reduce((s, sess) => s + sess.durationMinutes, 0);
  const activeDays = Object.keys(dailyActivity).length;

  return {
    summary: {
      totalSessions: sessions.length,
      totalMessages,
      totalUserMessages,
      totalCost,
      activeDays,
      totalDurationMinutes,
      projects: Object.keys(projectStats).length,
    },
    punchcard,
    dailyActivity,
    dailyCost,
    dailyTokens,
    projectStats,
    modelUsage,
    thinkingUsage,
  };
}

app.get("/api/stats/:source", (req, res) => {
  const source = req.params.source;
  if (source !== "pi" && source !== "claude") {
    return res.status(400).json({ error: "Source must be 'pi' or 'claude'" });
  }
  try {
    const sessions = source === "pi" ? parsePiSessions() : parseClaudeSessions();
    const stats = buildStats(sessions);
    stats.source = source;
    stats.sourceLabel = SOURCES[source].label;
    stats.costEstimated = source === "claude";
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Available sources
app.get("/api/sources", (req, res) => {
  const available = [];
  for (const [key, src] of Object.entries(SOURCES)) {
    if (fs.existsSync(src.sessionsDir)) {
      available.push({ id: key, label: src.label });
    }
  }
  res.json(available);
});

app.listen(PORT, () => {
  console.log(`agent-view running at http://localhost:${PORT}`);
});

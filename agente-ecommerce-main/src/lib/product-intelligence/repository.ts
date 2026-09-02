import path from "node:path";
import type { ResearchSession } from "./types";
import { intelligenceDataDir, readJsonRecovering, writeJsonAtomic } from "./persistence";

function filePath() {
  return path.join(intelligenceDataDir(), "product-intelligence.json");
}

function readAll(): ResearchSession[] {
  return readJsonRecovering(filePath(), () => [] as ResearchSession[]);
}

export function saveSession(session: ResearchSession): void {
  const sessions = readAll().filter((item) => item.id !== session.id);
  sessions.unshift(session);
  writeJsonAtomic(filePath(), sessions.slice(0, 100));
}

export function listSessions(): ResearchSession[] { return readAll(); }
export function getSession(id: string): ResearchSession | undefined { return readAll().find((item) => item.id === id); }
export function updateSessionStatus(id: string, status: ResearchSession["status"]): ResearchSession | undefined { const session = getSession(id); if (!session) return undefined; session.status = status; saveSession(session); return session; }
export function resetTestFixtureSessions(): string[] { const sessions = readAll(); const fixtures = sessions.filter((item) => item.source === "TEST_FIXTURE"); writeJsonAtomic(filePath(), sessions.filter((item) => item.source !== "TEST_FIXTURE")); return [...new Set(fixtures.flatMap((item) => item.products.map((product) => product.id)))]; }

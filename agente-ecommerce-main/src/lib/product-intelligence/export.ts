import { listSessions } from "./repository";
import { listSignals, listSnapshots, listWatchlist } from "./state";

export function exportProductDossiers(): string { return JSON.stringify(listSessions().flatMap((session) => session.products).filter((product, index, all) => all.findIndex((item) => item.id === product.id) === index), null, 2); }
export function exportWatchlist(): string { return JSON.stringify(listWatchlist(), null, 2); }
export function exportDailyReport(): string { const today = new Date().toISOString().slice(0, 10); return JSON.stringify({ date: today, snapshots: listSnapshots().filter((item) => item.capturedAt.startsWith(today)), signals: listSignals().filter((item) => item.createdAt.startsWith(today)) }, null, 2); }

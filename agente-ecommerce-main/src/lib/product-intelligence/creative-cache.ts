import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { intelligenceDataDir, readJsonRecovering, writeJsonAtomic } from "./persistence";

interface CachedCreative<T = unknown> { creativeHash: string; analysisVersion: string; analyzedAt: string; result: T }
function target() { return path.join(intelligenceDataDir(), "product-intelligence-creative-cache.json"); }
function read(): CachedCreative[] { return readJsonRecovering(target(), () => [] as CachedCreative[]); }
export function creativeHash(content: string | Buffer): string { return crypto.createHash("sha256").update(content).digest("hex"); }
export function getCreativeAnalysis<T>(hash: string, analysisVersion: string): T | undefined { return read().find((item) => item.creativeHash === hash && item.analysisVersion === analysisVersion)?.result as T | undefined; }
export function setCreativeAnalysis<T>(hash: string, analysisVersion: string, result: T): void { const all = read().filter((item) => !(item.creativeHash === hash && item.analysisVersion === analysisVersion)); all.push({ creativeHash: hash, analysisVersion, analyzedAt: new Date().toISOString(), result }); writeJsonAtomic(target(), all); }

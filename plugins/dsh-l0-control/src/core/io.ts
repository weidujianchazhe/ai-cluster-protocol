/**
 * 最小 I/O 适配（core 唯一允许碰文件系统的位置，且可注入替换）。
 *
 * 为什么单独一层：core 其余模块保持纯函数（可差分、可重放），
 * 只有 `submitEvidence` 需要真读产物算 sha256 —— 抽成 `CoreIo` 后，
 * 自检可以注入内存实现，N2/N5 用 `nodeIo`。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EvidenceError } from "./errors.ts";

export interface CoreIo {
  exists(filePath: string): boolean;
  isFile(filePath: string): boolean;
  sha256(filePath: string): string;
  readText(filePath: string): string;
  resolve(filePath: string, base?: string): string;
}

export const nodeIo: CoreIo = {
  exists: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  },
  isFile: (filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  sha256: (filePath) => {
    try {
      const buf = fs.readFileSync(filePath);
      return createHash("sha256").update(buf).digest("hex");
    } catch (error) {
      throw new EvidenceError(`产物不可读：${filePath}（${(error as Error).message}）`, "artifact-unreadable");
    }
  },
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new EvidenceError(`产物不可读：${filePath}（${(error as Error).message}）`, "artifact-unreadable");
    }
  },
  resolve: (filePath, base = process.cwd()) =>
    path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(base, filePath),
};

let activeIo: CoreIo = nodeIo;

export function configureIo(io: CoreIo | null): void {
  activeIo = io ?? nodeIo;
}

export function coreIo(): CoreIo {
  return activeIo;
}

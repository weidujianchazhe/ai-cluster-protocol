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
import { EvidenceError } from "./errors.js";

                         
                                    
                                    
                                   
                                     
                                                   
 

export const nodeIo         = {
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
      throw new EvidenceError(`产物不可读：${filePath}（${(error         ).message}）`, "artifact-unreadable");
    }
  },
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new EvidenceError(`产物不可读：${filePath}（${(error         ).message}）`, "artifact-unreadable");
    }
  },
  resolve: (filePath, base = process.cwd()) =>
    path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(base, filePath),
};

let activeIo         = nodeIo;

export function configureIo(io               )       {
  activeIo = io ?? nodeIo;
}

export function coreIo()         {
  return activeIo;
}


//# sourceURL=core\io.js
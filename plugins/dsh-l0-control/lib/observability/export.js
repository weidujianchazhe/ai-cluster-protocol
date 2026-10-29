/**
 * 导出（Lane O）：`observability.json` + `observability.log`（JSONL）。
 *
 * **fail-closed 脱敏**：写盘前对整段 JSON 做敏感值扫描（`sk-*` / `Bearer …` / 明文 password 等），
 * 命中就抛错**拒绝落盘**，而不是把疑似密钥写出去。观测数据本身不含 spec/prompt，
 * 这条是纵深防御（万一 `meta` 里混进了东西）。
 */
import fs from "node:fs";
import path from "node:path";

                                                          
import { observabilityLogLines, observabilityToJson } from "./projection.js";
import { SENSITIVE_VALUE_PATTERNS } from "./redact.js";

                               
                   
                    
                  
                   
 

                                
                                 
                    
                                
                   
                      
                 
                              
                   
 

/** 扫描敏感值；命中返回命中的模式描述，否则 null。 */
export function findSensitive(text        )                {
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(text)) return String(pattern);
  }
  return null;
}

/** 序列化 + 校验（不落盘）。 */
export function renderExport(projection                         , space = 2)   
               
                  
  {
  const json = observabilityToJson(projection, space);
  const sensitive = findSensitive(json);
  if (sensitive) {
    throw new Error(`observability export rejected: sensitive value matched ${sensitive}`);
  }
  return { json, lines: observabilityLogLines(projection) };
}

/** 落盘两个文件（目录自动创建）。 */
export function writeObservabilityExport(
  dir        ,
  projection                         ,
  options                = {},
)               {
  const { json, lines } = renderExport(projection, options.space ?? 2);
  const target = path.resolve(dir);
  const jsonPath = path.join(target, options.jsonName ?? "observability.json");
  const logPath = path.join(target, options.logName ?? "observability.log");
  if (options.dryRun) {
    return { jsonPath, jsonBytes: Buffer.byteLength(json), logPath, logLines: lines.length };
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(jsonPath, `${json}\n`, "utf8");
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  return {
    jsonPath,
    jsonBytes: Buffer.byteLength(json) + 1,
    logPath,
    logLines: lines.length,
  };
}


//# sourceURL=observability\export.js
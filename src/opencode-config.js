import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function opencodeConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  if (env.OPENCODE_CONFIG) return path.dirname(path.resolve(env.OPENCODE_CONFIG));
  return path.join(os.homedir(), '.config/opencode');
}

export function opencodeConfigFile(env = process.env) {
  if (env.OPENCODE_CONFIG) return path.resolve(env.OPENCODE_CONFIG);
  const dir = opencodeConfigDir(env);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

export function opencodeSkillFile(env = process.env, name = 'pi-subagents') {
  return path.join(opencodeConfigDir(env), 'skills', name, 'SKILL.md');
}

export function stripJsonc(source) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) { out += source[++i]; }
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  let cleaned = '';
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (ch === '\\' && j + 1 < out.length) cleaned += out[++j];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; cleaned += ch; continue; }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  return cleaned;
}

export function parseJsonc(source) {
  const stripped = stripJsonc(source).trim();
  return stripped ? JSON.parse(stripped) : {};
}

function tokenizeJsonc(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"') {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        i++;
      }
      tokens.push({ type: 'string', value: JSON.parse(source.slice(start, i)), start, end: i });
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({ type: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    const start = i;
    while (i < source.length && !/[\s{}[\]:,"/]/.test(source[i])) i++;
    tokens.push({ type: 'literal', value: source.slice(start, i), start, end: i });
  }
  return tokens;
}

function skipValue(tokens, index) {
  const tok = tokens[index];
  if (!tok) return index;
  if (tok.type !== '{' && tok.type !== '[') return index + 1;
  const open = tok.type;
  const close = open === '{' ? '}' : ']';
  let depth = 1;
  let i = index + 1;
  while (i < tokens.length && depth > 0) {
    if (tokens[i].type === open) depth++;
    else if (tokens[i].type === close) depth--;
    i++;
  }
  return i;
}

function findObjectProperty(tokens, objStart, key) {
  let i = objStart + 1;
  let prevComma = null;
  while (i < tokens.length && tokens[i].type !== '}') {
    if (tokens[i].type === ',') { prevComma = tokens[i]; i++; continue; }
    const keyTok = tokens[i];
    if (keyTok.type !== 'string' || tokens[i + 1]?.type !== ':') return null;
    const valStart = i + 2;
    const valEndIdx = skipValue(tokens, valStart);
    const valEndTok = tokens[valEndIdx - 1];
    const nextComma = tokens[valEndIdx]?.type === ',' ? tokens[valEndIdx] : null;
    if (keyTok.value === key) {
      return { keyTok, valStart, valEndTok, prevComma, nextComma };
    }
    prevComma = nextComma;
    i = nextComma ? valEndIdx + 1 : valEndIdx;
  }
  return null;
}

export function removeJsoncMcpServer(source, serverName) {
  const tokens = tokenizeJsonc(source);
  if (tokens[0]?.type !== '{') return { changed: false, content: source };
  const mcpProp = findObjectProperty(tokens, 0, 'mcp');
  if (!mcpProp || tokens[mcpProp.valStart]?.type !== '{') return { changed: false, content: source };
  const serversProp = findObjectProperty(tokens, mcpProp.valStart, 'servers');
  if (!serversProp || tokens[serversProp.valStart]?.type !== '{') return { changed: false, content: source };
  const target = findObjectProperty(tokens, serversProp.valStart, serverName);
  if (!target) return { changed: false, content: source };

  let removeStart = target.keyTok.start;
  while (removeStart > 0 && (source[removeStart - 1] === ' ' || source[removeStart - 1] === '\t')) removeStart--;
  let removeEnd = target.nextComma ? target.nextComma.end : target.valEndTok.end;
  if (source[removeEnd] === '\r' && source[removeEnd + 1] === '\n') removeEnd += 2;
  else if (source[removeEnd] === '\n') removeEnd += 1;
  else if (removeStart > 0 && source[removeStart - 1] === '\n') removeStart -= 1;

  let next = source.slice(0, removeStart) + source.slice(removeEnd);
  if (!target.nextComma && target.prevComma) {
    const commaPos = target.prevComma.start;
    next = source.slice(0, commaPos) + source.slice(commaPos + 1, removeStart) + source.slice(removeEnd);
  }
  try {
    parseJsonc(next);
    return { changed: true, content: next };
  } catch {
    const parsed = parseJsonc(source);
    if (parsed?.mcp?.servers && Object.prototype.hasOwnProperty.call(parsed.mcp.servers, serverName)) {
      delete parsed.mcp.servers[serverName];
      return { changed: true, content: `${JSON.stringify(parsed, null, 2)}\n` };
    }
    return { changed: false, content: source };
  }
}

export function inspectOpencodeConfig(env = process.env, serverName = 'pi-subagents') {
  const configFile = opencodeConfigFile(env);
  const skillFile = opencodeSkillFile(env, serverName);
  const configExists = fs.existsSync(configFile);
  let mcpConfigured = false;
  if (configExists) {
    try {
      const parsed = parseJsonc(fs.readFileSync(configFile, 'utf8'));
      mcpConfigured = Boolean(parsed?.mcp?.servers?.[serverName]);
    } catch {
      mcpConfigured = false;
    }
  }
  return {
    configFile,
    configExists,
    mcpConfigured,
    skillFile,
    skillInstalled: fs.existsSync(skillFile),
  };
}

/**
 * @hmh/domain-ops - channel (message notifications, the codelin channel gap)
 * Minimal honest version: a webhook notifier. Feishu (飞书) and DingTalk
 * (钉钉) custom-bot webhooks plus any generic JSON POST URL. The agent can
 * report task completion / build failures / device-test results to a chat
 * from inside the loop - "tell me when the emulator install finishes".
 * Config lives in HMH_HOME (webhook URLs are secrets-adjacent):
 *   config.json -> channels: { name: { type: 'feishu'|'dingtalk'|'json', url, secret? } }
 * Feishu sign: HMAC-SHA256(timestamp + "\n" + secret) base64 - their spec.
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type Tool } from '@hmh/kernel';

interface ChannelConfig {
  type: 'feishu' | 'dingtalk' | 'json';
  url: string;
  /** feishu: signing secret; dingtalk: secret for the signed URL */
  secret?: string;
}

function feishuSign(secret: string, timestamp: number): string {
  const hmac = createHmac('sha256', Buffer.from(timestamp + '\n' + secret, 'utf8'));
  return hmac.update('').digest('base64');
}

function dingtalkSignedUrl(url: string, secret: string): string {
  const ts = Date.now();
  const mac = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  const u = new URL(url);
  u.searchParams.set('timestamp', String(ts));
  u.searchParams.set('sign', encodeURIComponent(mac));
  return u.toString();
}

async function sendOne(ch: ChannelConfig, text: string): Promise<{ ok: boolean; detail: string }> {
  try {
    let url = ch.url;
    const body: Record<string, unknown> = {};
    if (ch.type === 'feishu') {
      const timestamp = Date.now();
      if (ch.secret) {
        body.timestamp = String(timestamp);
        body.sign = feishuSign(ch.secret, timestamp);
      }
      body.msg_type = 'text';
      body.content = { text };
    } else if (ch.type === 'dingtalk') {
      if (ch.secret) url = dingtalkSignedUrl(url, ch.secret);
      body.msgtype = 'text';
      body.text = { content: text };
    } else {
      body.text = text;
      body.time = new Date().toISOString();
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const out = await res.text();
    const ok = res.ok && !/"errcode":\s*[1-9]/.test(out); // feishu/dingtalk use errcode in 200s
    return { ok, detail: out.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

export async function sendNotification(home: string, channelName: string, text: string): Promise<{ ok: boolean; detail: string }> {
  let cfg: { channels?: Record<string, ChannelConfig> };
  try {
    cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as typeof cfg;
  } catch {
    // no config at all = nothing configured (same hint; file-absent is the
    // common first-run case, not an error state)
    cfg = {};
  }
  const ch = cfg.channels?.[channelName];
  if (!ch) {
    return { ok: false, detail: `channel "${channelName}" not configured. Add to config.json: channels: { ${JSON.stringify(channelName)}: { type: 'feishu'|'dingtalk'|'json', url, secret? } }` };
  }
  return sendOne(ch, text);
}

export const opsNotify: Tool = {
  name: 'ops_notify',
  description:
    'Send a notification to a configured chat channel (Feishu/DingTalk custom bot or generic JSON webhook). Configure once in HMH_HOME config.json: channels: { name: { type, url, secret? } }. Use to report task completion, build results, device-test verdicts - "tell me when it finishes".',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'configured channel name from config.json channels' },
      text: { type: 'string', description: 'the message text to deliver' },
    },
    required: ['channel', 'text'],
  },
  needsApproval: () => true, // outbound message = visible side effect
  async execute(args) {
    const name = String(args.channel ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!name || !text) return { output: 'channel and text required', isError: true };
    const { homeDir } = await import('@hmh/kernel');
    const r = await sendNotification(homeDir(), name, text);
    return {
      output: r.ok ? `notified ${name}: ${text.slice(0, 80)}` : `notify ${name} failed: ${r.detail}`,
      isError: !r.ok,
    };
  },
};

export const channelTools: Tool[] = [opsNotify];

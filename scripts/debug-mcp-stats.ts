import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function main() {
    const loreHome = process.env.LORE_HOME ?? path.join(os.homedir(), '.groundfloor');
    const token = fs.readFileSync(path.join(loreHome, 'auth.token'), 'utf8').trim();
    const t = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3847/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const c = new Client({ name: 'debug', version: '1' });
    await c.connect(t);
    const sr = await c.callTool({ name: 'stats', arguments: { workspace: 'default' } });
    const stext = (sr as any).content?.[0]?.text;
    let parsed: any; try { parsed = JSON.parse(stext); } catch { parsed = null; }
    console.log('verbatimDocuments_global:', parsed?.verbatimDocuments_global);
    console.log('nodeCount:', parsed?.nodeCount);
    const lr = await c.callTool({ name: 'list_nodes', arguments: { workspace: 'default', limit: 3 } });
    const ltext = (lr as any).content?.[0]?.text;
    let lp: any; try { lp = JSON.parse(ltext); } catch { lp = null; }
    console.log('list_nodes nodes:', lp?.nodes?.map((n: any) => n.id));
}
main().catch(e => { console.error(e.message); process.exit(1); });

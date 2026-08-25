export async function serveCommand(args: string[]): Promise<void> {
    const useHttp = args.includes('--http');

    if (useHttp) {
        process.argv.push('--http');
    }

    await import('../../mcp/server.js');
}

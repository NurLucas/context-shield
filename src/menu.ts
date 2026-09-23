import * as readline from 'node:readline';
import { runDemo } from './demo.js';
import { ProxyServer } from './proxy/server.js';
import { resolveConfig } from './config.js';
import { L2SqliteCache } from './cache/l2-sqlite.js';
import { SecretScanner } from './security/scanner.js';
import { execSync } from 'node:child_process';
import pc from 'picocolors';
import * as fs from 'node:fs';

export async function showInteractiveMenu(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
  };

  while (true) {
    console.log(pc.bold(pc.cyan('\n╔═══════════════════════════════════════════════════════════════╗')));
    console.log(pc.bold(pc.cyan('║          🛡️  CONTEXT-SHIELD CONTROLLER & GATEWAY             ║')));
    console.log(pc.bold(pc.cyan('╚═══════════════════════════════════════════════════════════════╝')));
    console.log(pc.dim('Select an action by entering the corresponding number:\n'));
    console.log(`  ${pc.bold(pc.green('[1]'))} Start Proxy Gateway (:8080) with Live Telemetry Dashboard`);
    console.log(`  ${pc.bold(pc.green('[2]'))} Run Live Demo & Visual Proof (Zero-Config Test)`);
    console.log(`  ${pc.bold(pc.green('[3]'))} Run Full Automated Test Suite (Vitest)`);
    console.log(`  ${pc.bold(pc.green('[4]'))} Scan a File or Prompt for Exposed Credentials`);
    console.log(`  ${pc.bold(pc.green('[5]'))} View Cumulative Token & Dollar Savings`);
    console.log(`  ${pc.bold(pc.green('[6]'))} Clear Persistent Cache`);
    console.log(`  ${pc.bold(pc.red('[0]'))} Exit\n`);

    const choice = (await promptUser(pc.bold('Enter choice [1-6, 0]: '))).trim();

    if (choice === '0') {
      console.log(pc.dim('Exiting ContextShield. Goodbye!'));
      rl.close();
      process.exit(0);
    } else if (choice === '1') {
      rl.close();
      console.log(pc.cyan('\nStarting ContextShield Proxy on http://127.0.0.1:8080...'));
      const config = resolveConfig();
      const server = new ProxyServer(config);
      await server.listen();

      console.log(pc.green(`✓ ContextShield Proxy listening on http://${config.host}:${config.port}/v1`));
      console.log(pc.dim('Point your IDE (Cursor/Aider/Claude Code) baseURL to http://127.0.0.1:8080/v1\n'));

      const collector = server.getMetricsCollector();
      setInterval(() => {
        process.stdout.write('\x1Bc');
        console.log(collector.renderDashboard());
        console.log(pc.dim(`\nProxy is running on http://${config.host}:${config.port}/v1. Press Ctrl+C to stop.`));
      }, 2000);

      const shutdown = async () => {
        console.log(pc.yellow('\nStopping ContextShield...'));
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return; // Keep running
    } else if (choice === '2') {
      await runDemo();
      await promptUser(pc.dim('\nPress Enter to return to the main menu...'));
    } else if (choice === '3') {
      console.log(pc.cyan('\nExecuting automated test suite...\n'));
      try {
        execSync('npm test', { stdio: 'inherit' });
      } catch {
        console.log(pc.red('\nSome tests encountered errors.'));
      }
      await promptUser(pc.dim('\nPress Enter to return to the main menu...'));
    } else if (choice === '4') {
      const target = (await promptUser('Enter path to file or text to scan: ')).trim();
      const scanner = new SecretScanner();
      if (fs.existsSync(target)) {
        const content = fs.readFileSync(target, 'utf-8');
        const result = scanner.scanText(content);
        if (result.hasSecrets) {
          console.log(pc.red(`\nFound ${result.findings.length} secrets in ${target}:`));
          for (const f of result.findings) {
            console.log(`  • ${f.description}: "${pc.yellow(f.matchedValue)}"`);
          }
        } else {
          console.log(pc.green('\n✓ No secrets detected in file.'));
        }
      } else {
        const result = scanner.scanText(target);
        if (result.hasSecrets) {
          console.log(pc.red(`\nSecrets detected in input:`));
          for (const f of result.findings) {
            console.log(`  • ${f.description}: "${pc.yellow(f.matchedValue)}"`);
          }
          console.log(`Sanitized: "${pc.green(result.sanitizedText)}"`);
        } else {
          console.log(pc.green('\n✓ No secrets detected in input text.'));
        }
      }
      await promptUser(pc.dim('\nPress Enter to return to the main menu...'));
    } else if (choice === '5') {
      const config = resolveConfig();
      const cache = new L2SqliteCache(config.l2DbPath);
      const stats = cache.getStats();
      console.log(pc.bold(pc.cyan('\n📊 Cumulative Caching Statistics')));
      console.log(`${pc.bold('Cached Queries:')}      ${stats.totalEntries.toLocaleString()}`);
      console.log(`${pc.bold('Cache Hit Count:')}     ${stats.totalHits.toLocaleString()}`);
      console.log(`${pc.bold('Total Tokens Saved:')}  ${pc.green(stats.tokensSaved.toLocaleString())}`);
      const estDollar = (stats.tokensSaved / 1000) * config.costPer1kPromptTokens;
      console.log(`${pc.bold('Est. Dollar Saved:')}   ${pc.bold(pc.green('$' + estDollar.toFixed(4)))} USD`);
      cache.close();
      await promptUser(pc.dim('\nPress Enter to return to the main menu...'));
    } else if (choice === '6') {
      const config = resolveConfig();
      const cache = new L2SqliteCache(config.l2DbPath);
      cache.clear();
      console.log(pc.green('\n✓ Persistent SQLite cache cleared.'));
      cache.close();
      await promptUser(pc.dim('\nPress Enter to return to the main menu...'));
    }
  }
}

#!/usr/bin/env node
import { Command } from 'commander';
import { ProxyServer } from './proxy/server.js';
import { resolveConfig } from './config.js';
import { SecretScanner } from './security/scanner.js';
import { L2SqliteCache } from './cache/l2-sqlite.js';
import pc from 'picocolors';
import * as fs from 'node:fs';
import * as path from 'node:path';

const program = new Command();

program
  .name('context-shield')
  .description('High-performance reverse proxy, secret redaction firewall, and caching engine for AI agents')
  .version('1.0.0');

program
  .command('start')
  .description('Start the ContextShield HTTP proxy and firewall server')
  .option('-p, --port <port>', 'Port to listen on', (val) => parseInt(val, 10))
  .option('-h, --host <host>', 'Host address to bind')
  .option('-u, --upstream <url>', 'Upstream LLM provider URL')
  .option('-k, --api-key <key>', 'Upstream API key')
  .option('--redact-mode <mode>', 'Security mode: redact, block, or off')
  .option('--no-l1', 'Disable in-memory L1 cache')
  .option('--no-l2', 'Disable persistent SQLite L2 cache')
  .option('--budget <tokens>', 'Session token budget limit', (val) => parseInt(val, 10))
  .option('--daily-budget <tokens>', 'Daily token budget limit', (val) => parseInt(val, 10))
  .option('--rate-limit <rpm>', 'Requests per minute allowed', (val) => parseInt(val, 10))
  .option('--db <path>', 'Custom path for SQLite database')
  .option('--dashboard', 'Display live refreshing telemetry in terminal')
  .action(async (opts) => {
    const config = resolveConfig({
      port: opts.port,
      host: opts.host,
      upstreamUrl: opts.upstream,
      apiKey: opts.apiKey,
      redactionMode: opts.redactMode,
      enableL1Cache: opts.l1,
      enableL2Cache: opts.l2,
      sessionTokenBudget: opts.budget,
      dailyTokenBudget: opts.dailyBudget,
      rateLimitPerMinute: opts.rateLimit,
      l2DbPath: opts.db,
    });

    console.log(pc.bold(pc.cyan('\n🛡️  ContextShield Gateway v1.0.0')));
    console.log(pc.dim('──────────────────────────────────────────────'));
    console.log(`${pc.bold('Listening on:')}      http://${config.host}:${config.port}`);
    console.log(`${pc.bold('Upstream URL:')}      ${config.upstreamUrl}`);
    console.log(`${pc.bold('Security Mode:')}     ${pc.yellow(config.redactionMode.toUpperCase())}`);
    console.log(
      `${pc.bold('Caching Engine:')}    L1: ${config.enableL1Cache ? pc.green('ON') : pc.dim('OFF')} | L2: ${config.enableL2Cache ? pc.green('ON') : pc.dim('OFF')}`
    );
    if (config.sessionTokenBudget > 0) {
      console.log(`${pc.bold('Session Budget:')}    ${config.sessionTokenBudget.toLocaleString()} tokens`);
    }
    console.log(pc.dim('──────────────────────────────────────────────\n'));
    console.log(pc.green(`✓ Drop-in ready: Configure your IDE/Agent baseURL to: http://${config.host}:${config.port}/v1\n`));

    const server = new ProxyServer(config);
    await server.listen();

    if (opts.dashboard) {
      const collector = server.getMetricsCollector();
      setInterval(() => {
        // Clear terminal screen and show telemetry
        process.stdout.write('\x1Bc');
        console.log(collector.renderDashboard());
        console.log(pc.dim(`\nPress Ctrl+C to stop the proxy.`));
      }, 2000);
    }

    const shutdown = async () => {
      console.log(pc.yellow('\nShutting down ContextShield gracefully...'));
      await server.close();
      console.log(pc.green('ContextShield stopped.'));
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('scan <target>')
  .description('Scan a prompt file or directory for exposed secrets and credentials')
  .action((target) => {
    const scanner = new SecretScanner();
    const resolvedPath = path.resolve(target);

    if (!fs.existsSync(resolvedPath)) {
      console.error(pc.red(`Error: Target not found at ${resolvedPath}`));
      process.exit(1);
    }

    console.log(pc.cyan(`\n🔍 Scanning ${resolvedPath} for sensitive credentials...\n`));

    const scanFile = (filePath: string) => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const result = scanner.scanText(content);
      if (result.hasSecrets) {
        console.log(pc.bold(pc.red(`[FAIL] Secrets found in ${path.relative(process.cwd(), filePath)}:`)));
        for (const finding of result.findings) {
          console.log(`  • ${pc.bold(finding.description)} (${finding.type}): "${pc.yellow(finding.matchedValue)}"`);
          if (finding.entropy) {
            console.log(`    Entropy: ${finding.entropy.toFixed(2)} bits`);
          }
        }
        console.log();
      }
    };

    const stat = fs.statSync(resolvedPath);
    if (stat.isFile()) {
      scanFile(resolvedPath);
    } else {
      const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(fullPath);
          else if (entry.isFile()) scanFile(fullPath);
        }
      };
      walk(resolvedPath);
    }

    console.log(pc.green('✓ Scan complete.\n'));
  });

program
  .command('stats')
  .description('Display cumulative caching and savings statistics from SQLite store')
  .option('--db <path>', 'Custom path for SQLite database')
  .action((opts) => {
    const config = resolveConfig({ l2DbPath: opts.db });
    const cache = new L2SqliteCache(config.l2DbPath);
    const stats = cache.getStats();

    console.log(pc.bold(pc.cyan('\n📊 ContextShield Cumulative Statistics')));
    console.log(pc.dim('──────────────────────────────────────────────'));
    console.log(`${pc.bold('Cached Queries:')}      ${stats.totalEntries.toLocaleString()}`);
    console.log(`${pc.bold('Cache Hit Count:')}     ${stats.totalHits.toLocaleString()}`);
    console.log(`${pc.bold('Total Tokens Saved:')}  ${pc.green(stats.tokensSaved.toLocaleString())}`);
    const estDollarSaved = (stats.tokensSaved / 1000) * config.costPer1kPromptTokens;
    console.log(`${pc.bold('Est. Dollar Saved:')}   ${pc.bold(pc.green('$' + estDollarSaved.toFixed(4)))} USD`);
    console.log(pc.dim('──────────────────────────────────────────────\n'));
    cache.close();
  });

program
  .command('cache')
  .description('Manage the persistent cache')
  .command('clear')
  .description('Purge all entries from the persistent SQLite cache')
  .action(() => {
    const config = resolveConfig();
    const cache = new L2SqliteCache(config.l2DbPath);
    cache.clear();
    console.log(pc.green('✓ Persistent cache cleared successfully.'));
    cache.close();
  });

program
  .command('init')
  .description('Scaffold a default .contextshieldrc.json configuration file')
  .action(() => {
    const configPath = path.join(process.cwd(), '.contextshieldrc.json');
    if (fs.existsSync(configPath)) {
      console.log(pc.yellow(`Configuration file already exists at ${configPath}`));
      return;
    }

    const template = {
      port: 8080,
      host: '127.0.0.1',
      upstreamUrl: 'https://api.openai.com',
      redactionMode: 'redact',
      enableL1Cache: true,
      l1MaxEntries: 1000,
      l1TtlMs: 86400000,
      enableL2Cache: true,
      rateLimitPerMinute: 120,
      sessionTokenBudget: 0,
      dailyTokenBudget: 0,
    };

    fs.writeFileSync(configPath, JSON.stringify(template, null, 2), 'utf-8');
    console.log(pc.green(`✓ Created configuration file: ${configPath}`));
  });

program
  .command('demo')
  .description('Run interactive zero-config demo verifying proxy, secret redaction, and caching')
  .action(async () => {
    const { runDemo } = await import('./demo.js');
    await runDemo();
  });

program
  .command('menu')
  .description('Open interactive terminal controller menu')
  .action(async () => {
    const { showInteractiveMenu } = await import('./menu.js');
    await showInteractiveMenu();
  });

// If launched with no arguments (e.g. double clicked executable), launch interactive menu
if (process.argv.length <= 2) {
  import('./menu.js').then(({ showInteractiveMenu }) => {
    showInteractiveMenu();
  });
} else {
  program.parse(process.argv);
}

#!/usr/bin/env node
/**
 * Audio Normalization Tool
 * 
 * Normalizes all audio files in public/audio (including subdirectories) to consistent loudness.
 * Uses ffmpeg's loudnorm filter with two-pass processing for accuracy.
 * 
 * Usage:
 *   npm run audio:normalize       - Normalize all audio files
 *   npm run audio:normalize:dry    - Dry run (show what would change)
 *   npm run audio:restore          - Restore latest backup
 *   node scripts/normalize-audio.mjs --help
 */

import { execSync, spawn } from 'child_process';
import { readdir, readFile, writeFile, mkdir, copyFile, stat, unlink } from 'fs/promises';
import { join, dirname, extname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const audioDir = join(projectRoot, 'public', 'audio');
const manifestPath = join(audioDir, '.normalize-manifest.json');

// Target loudness: -14 LUFS, true peak ≤ -1.5 dBTP, LRA ≈ 11
const TARGET_IL = -14.0;
const TARGET_TP = -1.5;
const TARGET_LRA = 11.0;
const TOLERANCE_LU = 0.5; // Skip if within ±0.5 LU of target
const MAX_CONCURRENT = 4;

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

function logTable(rows) {
  const colWidths = [];
  rows.forEach(row => {
    row.forEach((cell, i) => {
      if (!colWidths[i]) colWidths[i] = 0;
      colWidths[i] = Math.max(colWidths[i], String(cell || '').length);
    });
  });
  
  rows.forEach((row, idx) => {
    const line = row.map((cell, i) => String(cell || '').padEnd(colWidths[i] || 0)).join('  ');
    if (idx === 0) {
      log(colors.cyan, line);
      log(colors.cyan, '-'.repeat(line.length));
    } else {
      console.log(line);
    }
  });
}

function checkFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function printFfmpegHelp() {
  log(colors.red, 'Error: ffmpeg not found in PATH');
  console.log('\nTo install ffmpeg:');
  console.log('  macOS:   brew install ffmpeg');
  console.log('  Linux:   apt-get install ffmpeg  (or your package manager)');
  console.log('  Windows: choco install ffmpeg  (or download from https://ffmpeg.org)');
  console.log('\nAfter installing, ensure ffmpeg is in your PATH and try again.');
  process.exit(1);
}

async function findAudioFiles(dir, baseDir = dir) {
  const files = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('_backup_')) {
        files.push(...await findAudioFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.m4a' || ext === '.mp3') {
          files.push(fullPath);
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return files;
}

async function loadManifest() {
  try {
    const data = await readFile(manifestPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { files: {} };
  }
}

async function saveManifest(manifest) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function getFileHash(filePath) {
  try {
    const stats = await stat(filePath);
    return `${stats.size}-${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function measureLoudness(filePath) {
  return new Promise((resolve, reject) => {
    const cmd = [
      'ffmpeg',
      '-i', filePath,
      '-af', `loudnorm=I=${TARGET_IL}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
      '-f', 'null',
      '-'
    ];

    let stderr = '';
    const proc = spawn(cmd[0], cmd.slice(1));
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed: ${stderr}`));
        return;
      }
      
      try {
        // Extract JSON from stderr
        const jsonMatch = stderr.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          reject(new Error('Could not parse loudness data'));
          return;
        }
        const data = JSON.parse(jsonMatch[0]);
        resolve(data);
      } catch (err) {
        reject(new Error(`Parse error: ${err.message}`));
      }
    });
    
    proc.on('error', reject);
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args);
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) { // 1 can be normal for measurement pass
        reject(new Error(`ffmpeg failed: ${stderr}`));
        return;
      }
      resolve(stderr);
    });
    
    proc.on('error', reject);
    proc.stdin.end();
  });
}

async function normalizeFile(filePath, dryRun = false) {
  const relPath = relative(audioDir, filePath);
  const ext = extname(filePath);
  const isM4a = ext === '.m4a';
  
  try {
    // Measure current loudness
    const measured = await measureLoudness(filePath);
    const inputIL = parseFloat(measured.input_i);
    const inputTP = parseFloat(measured.input_tp);
    const inputLRA = parseFloat(measured.input_lra);
    const inputThresh = parseFloat(measured.input_thresh);
    
    // Calculate gain (estimated)
    const gain = TARGET_IL - inputIL;
    
    // Check if already normalized
    if (Math.abs(inputIL - TARGET_IL) <= TOLERANCE_LU) {
      return {
        file: relPath,
        skipped: true,
        reason: 'already normalized',
        inputIL,
        inputTP,
        gain: 0,
        outputIL: inputIL,
        outputTP: inputTP,
      };
    }
    
    if (dryRun) {
      return {
        file: relPath,
        skipped: false,
        inputIL,
        inputTP,
        gain,
        outputIL: TARGET_IL,
        outputTP: TARGET_TP,
      };
    }
    
    // Two-pass normalization
    const tempPath = filePath + '.tmp';
    
    // First pass: measure with linear=true
    const measureArgs = [
      '-i', filePath,
      '-af', `loudnorm=I=${TARGET_IL}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:linear=true:print_format=json`,
      '-f', 'null', '-'
    ];
    
    const measureStderr = await runFfmpeg(measureArgs);
    const measureMatch = measureStderr.match(/\{[\s\S]*\}/);
    if (!measureMatch) {
      throw new Error('Failed to extract measurement data from first pass');
    }
    const measureData = JSON.parse(measureMatch[0]);
    
    // Second pass: apply normalization using measured values
    const codec = isM4a ? 'aac' : 'libmp3lame';
    const codecArgs = isM4a ? ['-b:a', '192k'] : ['-q:a', '2'];
    
    const applyArgs = [
      '-i', filePath,
      '-af', `loudnorm=I=${TARGET_IL}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:linear=true:measured_I=${measureData.input_i}:measured_LRA=${measureData.input_lra}:measured_TP=${measureData.input_tp}:measured_thresh=${measureData.input_thresh}:offset=${measureData.target_offset}`,
      '-c:a', codec,
      ...codecArgs,
      '-y', tempPath
    ];
    
    await runFfmpeg(applyArgs);
    
    // Verify output
    const outputMeasured = await measureLoudness(tempPath);
    const outputIL = parseFloat(outputMeasured.input_i);
    const outputTP = parseFloat(outputMeasured.input_tp);
    const appliedGain = parseFloat(measureData.target_offset);
    
    // Replace original atomically
    await copyFile(tempPath, filePath);
    
    // Clean up temp file
    try {
      await unlink(tempPath);
    } catch {}
    
    return {
      file: relPath,
      skipped: false,
      inputIL,
      inputTP,
      gain: appliedGain,
      outputIL,
      outputTP,
    };
  } catch (err) {
    // Clean up temp file on error
    try {
      await unlink(filePath + '.tmp');
    } catch {}
    
    return {
      file: relPath,
      error: err.message,
    };
  }
}

async function createBackup(files) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(audioDir, `_backup_${timestamp}`);
  await mkdir(backupDir, { recursive: true });
  
  for (const file of files) {
    const relPath = relative(audioDir, file);
    const backupPath = join(backupDir, relPath);
    const backupDirPath = dirname(backupPath);
    await mkdir(backupDirPath, { recursive: true });
    await copyFile(file, backupPath);
  }
  
  return backupDir;
}

async function processFiles(files, dryRun = false) {
  const manifest = await loadManifest();
  const toProcess = [];
  
  // Filter files using manifest
  for (const file of files) {
    const relPath = relative(audioDir, file);
    const hash = await getFileHash(file);
    const entry = manifest.files[relPath];
    
    if (entry && entry.hash === hash && Math.abs(entry.lufs - TARGET_IL) <= TOLERANCE_LU) {
      continue; // Skip already normalized
    }
    
    toProcess.push(file);
  }
  
  if (toProcess.length === 0) {
    log(colors.green, 'All files already normalized.');
    return { processed: 0, skipped: files.length, failed: 0, results: [] };
  }
  
  if (!dryRun) {
    const backupDir = await createBackup(toProcess);
    log(colors.blue, `Backup created: ${relative(projectRoot, backupDir)}`);
  }
  
  // Process in parallel batches
  const results = [];
  for (let i = 0; i < toProcess.length; i += MAX_CONCURRENT) {
    const batch = toProcess.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(file => normalizeFile(file, dryRun))
    );
    results.push(...batchResults);
    
    // Update manifest
    for (const result of batchResults) {
      if (!result.error && !result.skipped) {
        const file = join(audioDir, result.file);
        const hash = await getFileHash(file);
        manifest.files[result.file] = {
          hash,
          lufs: result.outputIL,
          truePeak: result.outputTP,
          date: new Date().toISOString(),
        };
      }
    }
    
    if (!dryRun) {
      await saveManifest(manifest);
    }
  }
  
  const processed = results.filter(r => !r.skipped && !r.error).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => r.error).length;
  
  return { processed, skipped, failed, results, backupDir: dryRun ? null : relative(projectRoot, await findLatestBackup()) };
}

async function findLatestBackup() {
  try {
    const entries = await readdir(audioDir, { withFileTypes: true });
    const backupDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('_backup_'))
      .map(e => join(audioDir, e.name));
    
    if (backupDirs.length === 0) return null;
    
    // Sort by directory name (timestamp) descending
    backupDirs.sort().reverse();
    return backupDirs[0];
  } catch {
    return null;
  }
}

async function restoreBackup() {
  const latest = await findLatestBackup();
  if (!latest) {
    log(colors.red, 'No backup found to restore.');
    process.exit(1);
  }
  
  log(colors.blue, `Restoring from: ${relative(projectRoot, latest)}`);
  
  async function restoreDir(src, dest) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await restoreDir(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }
  
  await restoreDir(latest, audioDir);
  log(colors.green, 'Restore complete.');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Audio Normalization Tool

Usage:
  npm run audio:normalize          Normalize all audio files
  npm run audio:normalize:dry      Dry run (show what would change)
  npm run audio:restore            Restore latest backup

Target loudness:
  Integrated LUFS: ${TARGET_IL} LUFS
  True Peak: ≤ ${TARGET_TP} dBTP
  LRA: ≈ ${TARGET_LRA} LU

The tool will:
  • Create timestamped backups before processing
  • Skip files already normalized (idempotent)
  • Process files in parallel (max ${MAX_CONCURRENT} concurrent)
  • Write results to normalize-audio.log
    `);
    process.exit(0);
  }
  
  const isDryRun = args.includes('--dry') || process.env.npm_lifecycle_event === 'audio:normalize:dry';
  const isRestore = args.includes('--restore') || process.env.npm_lifecycle_event === 'audio:restore';
  
  if (!checkFfmpeg()) {
    printFfmpegHelp();
  }
  
  if (isRestore) {
    await restoreBackup();
    return;
  }
  
  // Ensure audio directory exists
  try {
    await mkdir(audioDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  
  const files = await findAudioFiles(audioDir);
  if (files.length === 0) {
    log(colors.yellow, 'No audio files found in public/audio');
    process.exit(0);
  }
  
  if (isDryRun) {
    log(colors.cyan, 'DRY RUN MODE - No files will be modified\n');
  }
  
  log(colors.blue, `Found ${files.length} audio file(s)\n`);
  
  const { processed, skipped, failed, results, backupDir } = await processFiles(files, isDryRun);
  
  // Build table
  const table = [['File', 'Input LUFS', 'Gain (dB)', 'Output LUFS', 'True Peak', 'Status']];
  
  results.forEach(r => {
    if (r.error) {
      table.push([r.file, '-', '-', '-', '-', colors.red + 'ERROR' + colors.reset]);
    } else if (r.skipped) {
      table.push([r.file, r.inputIL.toFixed(2), '0.00', r.outputIL.toFixed(2), r.outputTP.toFixed(2), colors.yellow + 'SKIP' + colors.reset]);
    } else {
      table.push([
        r.file,
        r.inputIL.toFixed(2),
        r.gain.toFixed(2),
        r.outputIL.toFixed(2),
        r.outputTP.toFixed(2),
        colors.green + 'OK' + colors.reset
      ]);
    }
  });
  
  logTable(table);
  
  console.log('\n' + '='.repeat(60));
  log(colors.cyan, `Processed: ${processed} | Skipped: ${skipped} | Failed: ${failed}`);
  if (backupDir) {
    log(colors.blue, `Backup: ${backupDir}`);
  }
  console.log('='.repeat(60));
  
  // Write log file
  const logStream = createWriteStream(join(projectRoot, 'normalize-audio.log'));
  logStream.write(`Audio Normalization - ${new Date().toISOString()}\n`);
  logStream.write('='.repeat(60) + '\n\n');
  table.forEach(row => {
    logStream.write(row.join('  ') + '\n');
  });
  logStream.write('\n' + '='.repeat(60) + '\n');
  logStream.write(`Processed: ${processed} | Skipped: ${skipped} | Failed: ${failed}\n`);
  if (backupDir) {
    logStream.write(`Backup: ${backupDir}\n`);
  }
  logStream.end();
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  log(colors.red, 'Fatal error:', err.message);
  console.error(err);
  process.exit(1);
});


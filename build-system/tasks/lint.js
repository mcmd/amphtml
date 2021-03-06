/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const argv = require('minimist')(process.argv.slice(2));
const colors = require('ansi-colors');
const config = require('../test-configs/config');
const deglob = require('globs-to-files');
const eslint = require('gulp-eslint');
const eslintIfFixed = require('gulp-eslint-if-fixed');
const fs = require('fs-extra');
const gulp = require('gulp');
const lazypipe = require('lazypipe');
const log = require('fancy-log');
const path = require('path');
const watch = require('gulp-watch');
const {gitDiffNameOnlyMaster} = require('../common/git');
const {isTravisBuild} = require('../common/travis');
const {maybeUpdatePackages} = require('./update-packages');

const isWatching = argv.watch || argv.w || false;
const options = {
  fix: false,
  quiet: argv.quiet || false,
};

const rootDir = path.dirname(path.dirname(__dirname));

/**
 * Initializes the linter stream based on globs
 * @param {!Object} globs
 * @param {!Object} streamOptions
 * @return {!ReadableStream}
 */
function initializeStream(globs, streamOptions) {
  let stream = gulp.src(globs, streamOptions);
  if (isWatching) {
    const watcher = lazypipe().pipe(
      watch,
      globs
    );
    stream = stream.pipe(watcher());
  }
  return stream;
}

/**
 * Logs a message on the same line to indicate progress
 * @param {string} message
 */
function logOnSameLine(message) {
  if (!isTravisBuild() && process.stdout.isTTY) {
    process.stdout.moveCursor(0, -1);
    process.stdout.cursorTo(0);
    process.stdout.clearLine();
  }
  log(message);
}

/**
 * Runs the linter on the given stream using the given options.
 * @param {!ReadableStream} stream
 * @param {!Object} options
 * @return {boolean}
 */
function runLinter(stream, options) {
  if (!isTravisBuild()) {
    log(colors.green('Starting linter...'));
  }
  const fixedFiles = {};
  return stream
    .pipe(eslint(options))
    .pipe(
      eslint.formatEach('stylish', function(msg) {
        logOnSameLine(msg.replace(`${rootDir}/`, '').trim() + '\n');
      })
    )
    .pipe(eslintIfFixed(rootDir))
    .pipe(
      eslint.result(function(result) {
        const relativePath = path.relative(rootDir, result.filePath);
        if (!isTravisBuild()) {
          logOnSameLine(colors.green('Linted: ') + relativePath);
        }
        if (options.fix && result.fixed) {
          const status =
            result.errorCount == 0
              ? colors.green('Fixed: ')
              : colors.yellow('Partially fixed: ');
          logOnSameLine(status + colors.cyan(relativePath));
          fixedFiles[relativePath] = status;
        }
      })
    )
    .pipe(
      eslint.results(function(results) {
        if (results.errorCount == 0 && results.warningCount == 0) {
          if (!isTravisBuild()) {
            logOnSameLine(
              colors.green('SUCCESS: ') + 'No linter warnings or errors.'
            );
          }
        } else {
          const prefix =
            results.errorCount == 0
              ? colors.yellow('WARNING: ')
              : colors.red('ERROR: ');
          logOnSameLine(
            prefix +
              'Found ' +
              results.errorCount +
              ' error(s) and ' +
              results.warningCount +
              ' warning(s).'
          );
          if (!options.fix) {
            log(
              colors.yellow('NOTE 1:'),
              'You may be able to automatically fix some of these warnings ' +
                '/ errors by running',
              colors.cyan('gulp lint --local_changes --fix'),
              'from your local branch.'
            );
            log(
              colors.yellow('NOTE 2:'),
              'Since this is a destructive operation (that edits your files',
              'in-place), make sure you commit before running the command.'
            );
            log(
              colors.yellow('NOTE 3:'),
              'If you see any',
              colors.cyan('prettier/prettier'),
              'errors, read',
              colors.cyan(
                'https://github.com/ampproject/amphtml/blob/master/contributing/getting-started-e2e.md#code-quality-and-style'
              )
            );
          }
        }
        if (options.fix && Object.keys(fixedFiles).length > 0) {
          log(colors.green('INFO: ') + 'Summary of fixes:');
          Object.keys(fixedFiles).forEach(file => {
            log(fixedFiles[file] + colors.cyan(file));
          });
        }
      })
    )
    .pipe(eslint.failAfterError());
}

/**
 * Extracts the list of lintable files in this PR from the commit log.
 *
 * @return {!Array<string>}
 */
function lintableFilesChanged() {
  const lintableFiles = deglob.sync(config.lintGlobs);
  return gitDiffNameOnlyMaster().filter(function(file) {
    return (
      fs.existsSync(file) &&
      lintableFiles.some(lintableFile => lintableFile.endsWith(file))
    );
  });
}

/**
 * Checks if there are eslint rule changes, in which case we must lint all
 * files.
 *
 * @return {boolean}
 */
function eslintRulesChanged() {
  return (
    gitDiffNameOnlyMaster().filter(function(file) {
      return (
        path.basename(file).includes('.eslintrc') ||
        path.dirname(file) === 'build-system/eslint-rules'
      );
    }).length > 0
  );
}

/**
 * Gets the list of files to be linted.
 *
 * @param {!Array<string>} files
 * @return {!Array<string>}
 */
function getFilesToLint(files) {
  const filesToLint = deglob.sync(files);
  if (!isTravisBuild()) {
    log(colors.green('INFO: ') + 'Running lint on the following files:');
    filesToLint.forEach(file => {
      log(colors.cyan(path.relative(rootDir, file)));
    });
  }
  return filesToLint;
}

/**
 * Run the eslinter on the src javascript and log the output
 * @return {!Stream} Readable stream
 */
function lint() {
  maybeUpdatePackages();
  if (argv.fix) {
    options.fix = true;
  }
  let filesToLint = config.lintGlobs;
  if (argv.files) {
    filesToLint = getFilesToLint(argv.files.split(','));
  } else if (!eslintRulesChanged() && argv.local_changes) {
    const lintableFiles = lintableFilesChanged();
    if (lintableFiles.length == 0) {
      log(colors.green('INFO: ') + 'No JS or OWNERS files in this PR');
      return Promise.resolve();
    }
    filesToLint = getFilesToLint(lintableFiles);
  }
  const stream = initializeStream(filesToLint, {base: rootDir});
  return runLinter(stream, options);
}

module.exports = {
  lint,
};

lint.description = 'Validates against Google Closure Linter';
lint.flags = {
  'watch': '  Watches for changes in files, validates against the linter',
  'fix': '  Fixes simple lint errors (spacing etc)',
  'local_changes': '  Lints just the files changed in the local branch',
  'quiet': '  Suppress warnings from outputting',
};

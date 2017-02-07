/**
 * @flow
 */

import 'instapromise';

import delayAsync from 'delay-async';
import existsAsync from 'exists-async';
import glob from 'glob';
import homeDir from 'home-dir';
import mkdirp from 'mkdirp';
import osascript from '@exponent/osascript';
import path from 'path';
import semver from 'semver';
import spawnAsync from '@exponent/spawn-async';
import rimraf from 'rimraf';
import fs from 'fs';

import * as Analytics from './Analytics';
import Api from './Api';
import ErrorCode from './ErrorCode';
import Logger from './Logger';
import NotificationCode from './NotificationCode';
import * as ProjectUtils from './project/ProjectUtils';
import UserSettings from './UserSettings';
import XDLError from './XDLError';
import * as UrlUtils from './UrlUtils';

let _lastUrl = null;

const SUGGESTED_XCODE_VERSION = `8.2.0`;

export function isPlatformSupported() {
  return process.platform === 'darwin';
}

function _isLicenseOutOfDate(text) {
  if (!text) {
    return false;
  }

  let lower = text.toLowerCase();
  return lower.includes('xcode') && lower.includes('license');
}

async function _xcrunAsync(args) {
  try {
    return await spawnAsync('xcrun', args);
  } catch (e) {
    if (_isLicenseOutOfDate(e.stdout) || _isLicenseOutOfDate(e.stderr)) {
      throw new XDLError(ErrorCode.XCODE_LICENSE_NOT_ACCEPTED, 'Xcode license is not accepted. Please run `sudo xcodebuild -license`.');
    } else {
      Logger.global.error(`Error running \`xcrun ${args.join(' ')}\`: ${e.stderr}`);
      throw e;
    }
  }
}

// Simulator installed
export async function _isSimulatorInstalledAsync() {
  let result;
  try {
    result = (await osascript.execAsync('id of app "Simulator"')).trim();
  } catch (e) {
    console.error("Can't determine id of Simulator app; the Simulator is most likely not installed on this machine", e);
    Logger.global.error("Simulator not installed. Please visit https://developer.apple.com/xcode/download/ to download Xcode and the iOS simulator");
    return false;
  }
  if (result !== 'com.apple.iphonesimulator') {
    console.warn("Simulator is installed but is identified as '" + result + "'; don't know what that is.");
    Logger.global.error("Simulator not installed. Please visit https://developer.apple.com/xcode/download/ to download Xcode and the iOS simulator. If you already have the latest version of Xcode installed, you may have to run the command `sudo xcode-select -s /Applications/Xcode.app`.");
    return false;
  }

  // check xcode version
  try {
    const { stdout } = await spawnAsync('xcodebuild', ['-version']);

    // find something that looks like a dot separated version number
    let matches = stdout.match(/[\d]{1,2}\.[\d]{1,3}/);
    if (matches.length === 0) {
      // very unlikely
      console.error('No version number found from `xcodebuild -version`.');
      Logger.global.error('Unable to check Xcode version. Command ran successfully but no version number was found.');
      return false;
    }

    // we're cheating to use the semver lib, but it expects a proper patch version which xcode doesn't have
    const version = matches[0] + '.0';

    if (!semver.valid(version)) {
      console.error('Invalid version number found: ' + matches[0]);
      return false;
    }

    if (semver.lt(version, SUGGESTED_XCODE_VERSION)) {
      console.warn(`Found Xcode ${version}, which is older than the recommended Xcode ${SUGGESTED_XCODE_VERSION}.`);
    }

  } catch (e) {
    // how would this happen? presumably if Simulator id is found then xcodebuild is installed
    console.error(`Unable to check Xcode version: ${e}`);
    Logger.global.error('You may need to install Xcode from https://developer.apple.com/xcode/download/.');
    return false;
  }

  // make sure we can run simctl
  try {
    await _xcrunAsync(['simctl', 'help']);
  } catch (e) {
    if (e.isXDLError) {
      Logger.global.error(e.toString());
    } else {
      console.warn(`Unable to run simctl: ${e.toString()}`);
      Logger.global.error('xcrun may not be configured correctly. Try running `sudo xcode-select --reset` and running this again.');
    }
    return false;
  }

  return true;
}

// Simulator opened
export async function _openSimulatorAsync() {
  if (!(await _isSimulatorRunningAsync())) {
    Logger.global.info("Opening iOS simulator");
    await spawnAsync('open', ['-a', 'Simulator']);
    await _waitForSimulatorRunningAsync();
  }
}

export async function _isSimulatorRunningAsync() {
  let zeroMeansNo = (await osascript.execAsync('tell app "System Events" to count processes whose name is "Simulator"')).trim();
  if (zeroMeansNo === '0') {
    return false;
  }

  let bootedDevice = await _bootedSimulatorDeviceAsync();
  return !!bootedDevice;
}

async function _waitForSimulatorRunningAsync() {
  if (await _isSimulatorRunningAsync()) {
    return true;
  } else {
    await delayAsync(100);
    return await _waitForSimulatorRunningAsync();
  }
}

async function _listSimulatorDevicesAsync() {
  let infoJson = await _xcrunAsync(['simctl', 'list', 'devices', '--json']);
  let info = JSON.parse(infoJson.stdout);
  return info;
}

async function _bootedSimulatorDeviceAsync() {
  let simulatorDeviceInfo = await _listSimulatorDevicesAsync();
  for (let runtime in simulatorDeviceInfo.devices) {
    let devices = simulatorDeviceInfo.devices[runtime];
    for (let i = 0; i < devices.length; i++) {
      let device = devices[i];
      if (device.state === 'Booted') {
        return device;
      }
    }
  }
  return null;
}

export function _dirForSimulatorDevice(udid: string) {
  return path.resolve(homeDir(), 'Library/Developer/CoreSimulator/Devices', udid);
}

export async function _quitSimulatorAsync() {
  return await osascript.execAsync('tell application "Simulator" to quit');
}

// Exponent installed
export async function _isExponentAppInstalledOnCurrentBootedSimulatorAsync() {
  let device = await _bootedSimulatorDeviceAsync();
  if (!device) {
    return false;
  }
  let simDir = await _dirForSimulatorDevice(device.udid);
  let matches = await glob.promise('./data/Containers/Data/Application/*/Library/Caches/Snapshots/host.exp.Exponent', {cwd: simDir});

  return (matches.length > 0);
}

export async function _waitForExponentAppInstalledOnCurrentBootedSimulatorAsync() {
  if (await _isExponentAppInstalledOnCurrentBootedSimulatorAsync()) {
    return true;
  } else {
    await delayAsync(100);
    return await _waitForExponentAppInstalledOnCurrentBootedSimulatorAsync();
  }
}

export async function _exponentVersionOnCurrentBootedSimulatorAsync() {
  let device = await _bootedSimulatorDeviceAsync();
  if (!device) {
    return null;
  }
  let simDir = await _dirForSimulatorDevice(device.udid);
  let matches = await glob.promise('./data/Containers/Bundle/Application/*/Exponent-*.app', {cwd: simDir});

  if (matches.length === 0) {
    return null;
  }

  let regex = /Exponent\-([0-9\.]+)\.app/;
  let regexMatch = regex.exec(matches[0]);
  if (regexMatch.length < 2) {
    return null;
  }

  return regexMatch[1];
}

export async function _checkExponentUpToDateAsync() {
  let versions = await Api.versionsAsync();
  let installedVersion = await _exponentVersionOnCurrentBootedSimulatorAsync();

  if (!installedVersion || semver.lt(installedVersion, versions.iosVersion)) {
    Logger.notifications.warn({code: NotificationCode.OLD_IOS_APP_VERSION}, 'This version of the Exponent app is out of date. Uninstall the app and run again to upgrade.');
  }
}

export async function _downloadSimulatorAppAsync() {
  let versions = await Api.versionsAsync();
  let dir = path.join(_simulatorCacheDirectory(), `Exponent-${versions.iosVersion}.app`);

  if (await existsAsync(dir)) {
    let filesInDir = await fs.promise.readdir(dir);
    if (filesInDir.length > 0) {
      return dir;
    } else {
      rimraf.sync(dir);
    }
  }

  mkdirp.sync(dir);
  try {
    let url = `https://s3.amazonaws.com/exp-ios-simulator-apps/Exponent-${versions.iosVersion}.tar.gz`;
    await Api.downloadAsync(url, dir, {extract: true});
  } catch (e) {
    rimraf.sync(dir);
    throw e;
  }

  return dir;
}

export async function _installExponentOnSimulatorAsync() {
  Logger.global.info(`Downloading latest version of Exponent`);
  Logger.notifications.info({code: NotificationCode.START_LOADING});
  let dir = await _downloadSimulatorAppAsync();
  Logger.global.info("Installing Exponent on iOS simulator");
  let result = await _xcrunAsync(['simctl', 'install', 'booted', dir]);
  Logger.notifications.info({code: NotificationCode.STOP_LOADING});
  return result;
}

export async function _uninstallExponentAppFromSimulatorAsync() {
  try {
    Logger.global.info('Uninstalling Exponent from iOS simulator.');
    await _xcrunAsync(['simctl', 'uninstall', 'booted', 'host.exp.Exponent']);
  } catch (e) {
    if (e.message && e.message.includes('No devices are booted.')) {
      return null;
    } else {
      console.error(e);
      throw e;
    }
  }
}

export function _simulatorCacheDirectory() {
  let dotExponentHomeDirectory = UserSettings.dotExponentHomeDirectory();
  let dir = path.join(dotExponentHomeDirectory, 'ios-simulator-app-cache');
  mkdirp.sync(dir);
  return dir;
}

export async function upgradeExponentAsync() {
  if (!(await _isSimulatorInstalledAsync())) {
    return;
  }

  await _openSimulatorAsync();

  await _uninstallExponentAppFromSimulatorAsync();
  await _installExponentOnSimulatorAsync();

  if (_lastUrl) {
    Logger.global.info(`Opening ${_lastUrl} in Exponent.`);
    await _xcrunAsync(['simctl', 'openurl', 'booted', _lastUrl]);
    _lastUrl = null;
  }
}

// Open Url
export async function _openUrlInSimulatorAsync(url: string) {
  return await _xcrunAsync(['simctl', 'openurl', 'booted', url]);
}

export async function openUrlInSimulatorSafeAsync(url: string, isDetached: boolean = false) {
  if (!(await _isSimulatorInstalledAsync())) {
    return {
      success: false,
      msg: 'Unable to verify Xcode and Simulator installation.',
    };
  }

  try {
    await _openSimulatorAsync();

    if (!isDetached && !(await _isExponentAppInstalledOnCurrentBootedSimulatorAsync())) {
      await _installExponentOnSimulatorAsync();
      await _waitForExponentAppInstalledOnCurrentBootedSimulatorAsync();
    }

    if (!isDetached) {
      _lastUrl = url;
      _checkExponentUpToDateAsync(); // let this run in background
    }

    Logger.global.info(`Opening ${url} in iOS simulator`);
    await _openUrlInSimulatorAsync(url);
  } catch (e) {
    if (e.isXDLError) {
      // Hit some internal error, don't try again.
      // This includes Xcode license errors
      Logger.global.error(e.message);
      return {
        success: false,
        msg: `${e.toString()}`,
      };
    }

    if (isDetached) {
      Logger.global.error(`Error running app. Have you installed the app already using Xcode? Since you are detached you must build manually. ${e.toString()}`);
    } else {
      Logger.global.error(`Error installing or running app. ${e.toString()}`);
    }

    return {
      success: false,
      msg: `${e.toString()}`,
    };
  }

  Analytics.logEvent('Open Url on Device', {
    platform: 'ios',
  });

  return {
    success: true,
  };
}

export async function openProjectAsync(projectRoot: string) {
  let projectUrl = await UrlUtils.constructManifestUrlAsync(projectRoot, {
    hostType: 'localhost',
  });

  let { exp } = await ProjectUtils.readConfigJsonAsync(projectRoot);

  await openUrlInSimulatorSafeAsync(projectUrl, !!exp.isDetached);
}

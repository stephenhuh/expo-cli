import { ConfigPlugin, ExpoConfig } from '../Config.types';
import { withInfoPlist } from '../plugins/withPlist';
import { InfoPlist } from './IosConfig.types';

export function getUsesNonExemptEncryption(config: ExpoConfig) {
  return config.ios?.config?.hasOwnProperty('usesNonExemptEncryption')
    ? !!config.ios.config.usesNonExemptEncryption
    : null;
}

export const withUsesNonExemptEncryption: ConfigPlugin = config =>
  withInfoPlist(config, setUsesNonExemptEncryption);

export function setUsesNonExemptEncryption(config: ExpoConfig, infoPlist: InfoPlist) {
  const usesNonExemptEncryption = getUsesNonExemptEncryption(config);

  // Make no changes if the key is left blank
  if (usesNonExemptEncryption === null) {
    return infoPlist;
  }

  return {
    ...infoPlist,
    ITSAppUsesNonExemptEncryption: usesNonExemptEncryption,
  };
}

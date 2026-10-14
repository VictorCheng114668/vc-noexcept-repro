module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo auto-includes the react-native-worklets plugin when
    // react-native-worklets is installed — same chain as a stock Expo SDK 57 app.
    presets: ['babel-preset-expo'],
  };
};

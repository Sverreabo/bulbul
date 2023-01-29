module.exports = {
    plugins: [
        require("autoprefixer"),
        require("postcss-reporter"),
        require("postcss-preset-env"),
        require("cssnano")
    ],
};
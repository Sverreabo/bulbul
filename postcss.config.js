module.exports = {
    plugins: [
        require("autoprefixer"),
        require("stylelint"),
        require("postcss-reporter"),
        require("postcss-preset-env"),
        require("cssnano")
    ],
};
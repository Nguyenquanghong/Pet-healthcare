/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#003f70",
        "primary-dark": "#002f55",
        aqua: "#d9efec",
        canvas: "#f7f8fa",
        ink: "#17202a",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15, 23, 42, 0.06)",
      },
    },
  },
  plugins: [],
};

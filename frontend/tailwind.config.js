/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Vazir', 'Tahoma', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

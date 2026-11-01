// The planted-bug project from the docs' "Your first debug" page
// (apps/docs/content/docs/first-debug.mdx), for `debugai-mcp try`.
//
// The files are the page's, byte for byte, and test/firstBug.test.ts fails when
// the two drift: the page prints the traceback these files produce, line numbers
// included, and says what the answer should name. A file that moved by one line
// would make the page wrong on someone's first run.
//
// In each language the line that crashes is not the line that is wrong, and the
// traceback never names the file that is. That is the point of the exercise.

export type FirstBugLang = 'python' | 'js';

const PYTHON: Array<[string, string[]]> = [
  ['settings.py', [
    '# Shop settings. In a real app these come from the environment.',
    'TAX_RATE = "0.08"',
    'FREE_SHIPPING_OVER = 50',
  ]],
  ['cart.py', [
    'from settings import TAX_RATE, FREE_SHIPPING_OVER',
    '',
    '',
    'def subtotal(items):',
    '    return sum(item["price"] * item["qty"] for item in items)',
    '',
    '',
    'def total(items):',
    '    sub = subtotal(items)',
    '    shipping = 0 if sub >= FREE_SHIPPING_OVER else 5',
    '    return round(sub * (1 + TAX_RATE) + shipping, 2)',
  ]],
  ['main.py', [
    'from cart import total',
    '',
    'items = [',
    '    {"name": "keyboard", "price": 49.0, "qty": 1},',
    '    {"name": "cable", "price": 6.5, "qty": 2},',
    ']',
    'print(f"Total: {total(items)}")',
  ]],
];

const JS: Array<[string, string[]]> = [
  ['data.js', [
    '// Users as they come back from the API, where ids are strings.',
    'module.exports.users = [',
    '  { id: "1", name: "Ada" },',
    '  { id: "2", name: "Linus" },',
    '];',
  ]],
  ['users.js', [
    'const { users } = require("./data");',
    '',
    'function findUser(id) {',
    '  return users.find((user) => user.id === id);',
    '}',
    '',
    'module.exports = { findUser };',
  ]],
  ['main.js', [
    'const { findUser } = require("./users");',
    '',
    'const user = findUser(2);',
    'console.log(`Hello, ${user.name}`);',
  ]],
];

/** The files, in the order the page shows them, each ending in a newline as a code block does. */
export function firstBugFiles(lang: FirstBugLang): Array<{ name: string; text: string }> {
  return (lang === 'python' ? PYTHON : JS).map(([name, lines]) => ({ name, text: `${lines.join('\n')}\n` }));
}

/** The command that runs it, and shows the error. */
export const FIRST_BUG_RUN: Record<FirstBugLang, string> = {
  python: 'python main.py',
  js: 'node main.js',
};

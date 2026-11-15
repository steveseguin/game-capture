'use strict';
const choice = document.getElementById('recipe-choice');
const summary = document.getElementById('recipe-summary');
const status = document.getElementById('copy-status');
function selectedRecipe() {
  return choice.selectedOptions[0].dataset.recipe;
}
function showRecipeParts(parts) {
  summary.replaceChildren();
  for (const part of parts) {
    const line = document.createElement('span');
    line.className = 'recipe-line';
    line.textContent = part.trim();
    summary.append(line, document.createTextNode('\n'));
  }
}
function updateRecipe() {
  const parts = selectedRecipe().split(';');
  parts[0] = parts[0].slice(parts[0].indexOf(':') + 1);
  showRecipeParts(parts.slice(0, 3));
  status.textContent = '';
}
choice.addEventListener('change', updateRecipe);
updateRecipe();
document.getElementById('copy-recipe').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(selectedRecipe());
    status.textContent = 'Settings copied. Apply them in the app before publishing.';
  } catch {
    status.textContent = 'Clipboard unavailable. Select and copy the settings text above.';
    showRecipeParts(selectedRecipe().split(';'));
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(summary);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
document.getElementById('print-guide').addEventListener('click', () => window.print());

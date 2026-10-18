'use strict';
const choice = document.getElementById('recipe-choice');
const summary = document.getElementById('recipe-summary');
const status = document.getElementById('copy-status');
function updateRecipe() {
  summary.textContent = choice.selectedOptions[0].dataset.recipe;
  status.textContent = '';
}
choice.addEventListener('change', updateRecipe);
updateRecipe();
document.getElementById('copy-recipe').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(summary.textContent);
    status.textContent = 'Settings copied. Apply them in the app before publishing.';
  } catch {
    status.textContent = 'Clipboard unavailable. Select and copy the settings text above.';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(summary);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
document.getElementById('print-guide').addEventListener('click', () => window.print());

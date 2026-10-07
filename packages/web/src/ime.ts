// IME composition (Vietnamese Telex/VNI, Gboard, Japanese, Chinese...): keys pressed while an input method composes belong to it.

/** A keydown the input method owns: Chrome/Edge/Firefox mark it isComposing; Safari ends the composition first but keeps keyCode 229 on the committing key. */
export const isImeKey = (e: { isComposing?: boolean; keyCode?: number }) => !!e.isComposing || e.keyCode === 229;

// Stub: the red run of issue 508 imports these before they exist.
import { el } from '../dom.js';

export const PLANNABLE_TYPES = new Set();
export const planState = () => 'hidden';
export const cardPlanParts = () => ({ badge: null, note: null, actions: null });
export const planConfirm = () => el('div');
export const missingFolder = () => el('div');

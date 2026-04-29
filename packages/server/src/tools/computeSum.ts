import { ToolResult } from '../types/index.js';

// This tool computes the sum of an array of numeric values.
// Use this when you need to add up multiple values from tool outputs — NEVER sum values yourself.
export async function computeSum(args: {
  values:  number[];
  label?:  string;
  items?:  string[];  // Optional labels for each value (for traceability)
}): Promise<ToolResult> {
  const { values, label = 'Total', items } = args;

  if (!Array.isArray(values) || values.length === 0) {
    return {
      success: false,
      data: 'No values provided to sum.',
      sources: [],
    };
  }

  const validValues = values.filter((v) => typeof v === 'number' && !isNaN(v));
  if (validValues.length === 0) {
    return {
      success: false,
      data: 'No valid numeric values to sum.',
      sources: [],
    };
  }

  const total = validValues.reduce((sum, v) => sum + v, 0);
  const count = validValues.length;

  const breakdown = items && items.length === validValues.length
    ? validValues.map((v, i) => ({ item: items[i], value: v }))
    : undefined;

  return {
    success: true,
    data: {
      label,
      count,
      total,
      breakdown,
    },
    sources: [],
  };
}

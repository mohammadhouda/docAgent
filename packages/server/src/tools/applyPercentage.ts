import { ToolResult } from '../types/index.js';

export async function applyPercentage(args: {
  baseAmount:  number;
  rate:        number;
  operation?:  'add' | 'subtract';
  labelBase?:  string;
  labelRate?:  string;
}): Promise<ToolResult> {
  const {
    baseAmount,
    rate,
    operation  = 'add',
    labelBase  = 'Base amount',
    labelRate  = 'Rate',
  } = args;

  const percentageAmount = Math.round((baseAmount * rate) / 100 * 100) / 100;
  const result = operation === 'add'
    ? Math.round((baseAmount + percentageAmount) * 100) / 100
    : Math.round((baseAmount - percentageAmount) * 100) / 100;

  const operationLabel = operation === 'add' ? 'inclusive' : 'exclusive';

  return {
    success: true,
    data: {
      [labelBase]:     baseAmount,
      [`${labelRate} (${rate}%)`]: percentageAmount,
      [`Total (${operationLabel})`]: result,
      operation,
      rate,
    },
    sources: [],
  };
}

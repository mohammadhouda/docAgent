import { ToolResult } from '../types/index.js';

export async function computeDifference(args: {
  valueA:  number;
  labelA?: string;
  valueB:  number;
  labelB?: string;
}): Promise<ToolResult> {
  const { valueA, valueB, labelA = 'Value A', labelB = 'Value B' } = args;

  const difference        = valueA - valueB;
  const absoluteDifference = Math.abs(difference);
  const percentageDifference = valueB !== 0
    ? Math.round((difference / valueB) * 10000) / 100
    : null;

  return {
    success: true,
    data: {
      [labelA]:            valueA,
      [labelB]:            valueB,
      difference,
      absoluteDifference,
      percentageDifference,
      higher: difference >= 0 ? labelA : labelB,
      lower:  difference >= 0 ? labelB : labelA,
    },
    sources: [],
  };
}

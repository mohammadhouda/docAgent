import {
  AnswerSection,
  KeyFactsSection,
  ListSection,
  PartiesSection,
  ParagraphSection,
  StructuredAnswer,
  TableSection,
  TimelineSection,
} from '@/lib/api';

function Citation({ text }: { text: string }) {
  return (
    <span className="text-xs text-blue-500 italic ml-1">[{text}]</span>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{title}</h4>
  );
}

function Paragraph({ section }: { section: ParagraphSection }) {
  return <p className="text-sm text-gray-800 leading-relaxed">{section.content}</p>;
}

function KeyFacts({ section }: { section: KeyFactsSection }) {
  return (
    <div>
      <SectionHeading title={section.title} />
      <dl className="space-y-1.5">
        {section.items.map((item, i) => (
          <div key={i} className="flex gap-3 text-sm">
            <dt className="text-gray-500 font-medium shrink-0 w-36">{item.label}</dt>
            <dd className="text-gray-900 font-semibold">
              {item.value}
              {item.citation && <Citation text={item.citation} />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Timeline({ section }: { section: TimelineSection }) {
  return (
    <div>
      <SectionHeading title={section.title} />
      <ol className="relative border-l-2 border-blue-100 pl-4 space-y-3">
        {section.items.map((item, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-blue-400 border-2 border-white" />
            <span className="text-xs font-semibold text-blue-600 block">{item.date}</span>
            <span className="text-sm text-gray-800">{item.label}</span>
            {item.citation && <Citation text={item.citation} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DataTable({ section }: { section: TableSection }) {
  return (
    <div>
      <SectionHeading title={section.title} />
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {section.headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row, i) => (
              <tr key={i} className={`border-b border-gray-100 last:border-0 ${i % 2 === 1 ? 'bg-gray-50/50' : 'bg-white'}`}>
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-2 text-gray-800">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BulletList({ section }: { section: ListSection }) {
  return (
    <div>
      <SectionHeading title={section.title} />
      <ul className="space-y-1.5">
        {section.items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
            <span className="text-gray-800">
              {item.text}
              {item.citation && <Citation text={item.citation} />}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Parties({ section }: { section: PartiesSection }) {
  return (
    <div>
      <SectionHeading title={section.title} />
      <div className="grid grid-cols-1 gap-2">
        {section.items.map((item, i) => (
          <div key={i} className="flex gap-3 items-start rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide w-20 shrink-0 mt-0.5">{item.role}</span>
            <span className="text-sm text-gray-900 font-medium">
              {item.name}
              {item.citation && <Citation text={item.citation} />}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ section }: { section: AnswerSection }) {
  switch (section.type) {
    case 'paragraph':  return <Paragraph section={section} />;
    case 'key_facts':  return <KeyFacts section={section} />;
    case 'timeline':   return <Timeline section={section} />;
    case 'table':      return <DataTable section={section} />;
    case 'list':       return <BulletList section={section} />;
    case 'parties':    return <Parties section={section} />;
  }
}

export default function StructuredAnswerView({ answer }: { answer: StructuredAnswer }) {
  return (
    <div className="space-y-4">
      {answer.title && (
        <p className="text-sm font-semibold text-gray-900">{answer.title}</p>
      )}
      {answer.summary && (
        <p className="text-sm text-gray-500 italic border-l-2 border-blue-200 pl-2">{answer.summary}</p>
      )}
      {answer.sections.map((section, i) => (
        <Section key={i} section={section} />
      ))}
    </div>
  );
}

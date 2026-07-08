import React, { useMemo } from 'react';
import { X, BarChart2 } from 'lucide-react';
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Scatter,
  Cell,
  LabelList
} from 'recharts';

interface AnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: any[];
  fontFamily: string;
  fontSizeOffset: number;

  // Configuration Props
  title?: string;
  unit?: string;
  getValue?: (item: any) => number;
  getLabel?: (item: any) => string;
}

// Helper to wrap text for X-Axis
const splitText = (text: string, maxLen: number = 8) => {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + words[i].length + 1 <= maxLen) {
      currentLine += ' ' + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines;
};

const CustomXAxisTick = ({ x, y, payload, fontSize }: any) => {
  const lines = splitText(payload.value);
  // Adjusted dy to 25 to move text below the axis line to prevent overlap
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={25}
        textAnchor="middle"
        fill="#9CA3AF"
        fontSize={fontSize}
        fontFamily="inherit"
      >
        {lines.map((line, index) => (
          <tspan x={0} dy={index === 0 ? 0 : fontSize * 1.3} key={index}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
};

const AnalysisModal: React.FC<AnalysisModalProps> = ({
  isOpen,
  onClose,
  data,
  fontFamily,
  fontSizeOffset,
  title = "매물 시세 분석",
  unit = "만원",
  getValue = (item: any) => item.prc, // Default to Naver
  getLabel = (item: any) => item.atclNm // Default to Naver
}) => {
  if (!isOpen) return null;

  // Font Size Calculations
  const offsetPx = fontSizeOffset * 2;
  const sizeTitle = 30 + offsetPx;
  const sizeXAxis = 14 + offsetPx;
  const sizeYAxis = 17 + offsetPx;
  const sizeLegend = 17 + offsetPx;
  const sizeTooltip = 16 + offsetPx;
  const sizeLabel = 14 + offsetPx;

  // Process Data: Group by LabelName
  const chartData = useMemo(() => {
    const groups: Record<string, number[]> = {};

    data.forEach(item => {
      const name = getLabel(item);
      const val = getValue(item);
      if (isNaN(val)) return;

      if (!groups[name]) groups[name] = [];
      groups[name].push(val);
    });

    const processed = Object.entries(groups).map(([name, values]) => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / values.length;
      const count = values.length;

      return {
        name,
        min,
        max,
        avg: parseFloat(avg.toFixed(1)), // Round to 1 decimal
        count,
        priceRange: [min, max] as [number, number]
      };
    });

    // Sort by Average Descending
    return processed.sort((a, b) => b.avg - a.avg);
  }, [data, getValue, getLabel]);

  // Calculate global min/max for Y-axis domain
  const allValues = data.map(item => getValue(item)).filter(v => !isNaN(v));
  const globalMin = allValues.length ? Math.min(...allValues) * 0.9 : 0;
  const globalMax = allValues.length ? Math.max(...allValues) * 1.05 : 100;

  const formatValue = (value: number) => {
    if (unit === '만원') {
      if (value >= 10000) return `${(value / 10000).toFixed(1)}억`;
      return `${(value / 1000).toFixed(1)}천`;
    }
    // Simple number formatting for Rate, etc.
    return value.toLocaleString();
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const info = payload[0].payload;
      return (
        <div className="bg-gray-800 border border-gray-600 p-4 rounded shadow-xl z-50">
          <p className="font-bold text-white mb-2" style={{ fontSize: `${sizeTooltip + 2}px` }}>{label}</p>
          <p className="text-cyan-400" style={{ fontSize: `${sizeTooltip}px` }}>평균: {info.avg.toLocaleString()} {unit} {unit === '만원' && `(${formatValue(info.avg)})`}</p>
          <p className="text-gray-300" style={{ fontSize: `${sizeTooltip}px` }}>최저: {info.min.toLocaleString()} {unit}</p>
          <p className="text-gray-300" style={{ fontSize: `${sizeTooltip}px` }}>최고: {info.max.toLocaleString()} {unit}</p>
          <p className="text-yellow-400 mt-2 font-semibold" style={{ fontSize: `${sizeTooltip}px` }}>데이터 수: {info.count}건</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80 backdrop-blur-sm" style={{ fontFamily }}>
      <div className="bg-gray-900 rounded-xl shadow-2xl w-[90vw] h-[90vh] flex flex-col border border-gray-700 overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-800 bg-gray-850 shrink-0">
          <div>
            <h2 className="font-bold text-white flex items-center gap-3" style={{ fontSize: `${sizeTitle}px` }}>
              <BarChart2 className="text-purple-500" size={sizeTitle} /> {title}
            </h2>
            <p className="text-gray-400 mt-2" style={{ fontSize: `${sizeTooltip}px` }}>
              총 <span className="text-white font-bold">{chartData.length}</span>개 그룹,
              <span className="text-white font-bold"> {data.length}</span>개 데이터 분석 결과 (평균 순)
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={sizeTitle} />
          </button>
        </div>

        {/* Chart Content */}
        <div className="flex-grow p-6 overflow-hidden flex flex-col">
          {chartData.length === 0 ? (
            <div className="flex-grow flex items-center justify-center text-gray-400 text-lg">
              분석할 데이터가 없습니다.
            </div>
          ) : (
            <div className="w-full h-full bg-gray-800/50 rounded-lg p-4 border border-gray-700 relative">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  layout="horizontal"
                  margin={{ top: 30, right: 30, left: 20, bottom: 60 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis
                    dataKey="name"
                    interval={0}
                    tick={<CustomXAxisTick fontSize={sizeXAxis} />}
                    height={80}
                  />
                  <YAxis
                    stroke="#9CA3AF"
                    tick={{ fill: '#9CA3AF', fontSize: sizeYAxis }}
                    domain={[globalMin, globalMax]}
                    tickFormatter={(val) => formatValue(val)}
                    width={90}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                  <Legend wrapperStyle={{ paddingTop: '10px', fontSize: `${sizeLegend}px` }} />

                  {/* Range Bar (Min to Max) */}
                  <Bar dataKey="priceRange" name={`범위 (최저~최고)`} barSize={24} fill="#6366f1" radius={[4, 4, 4, 4]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fillOpacity={0.6} />
                    ))}
                    <LabelList
                      dataKey="count"
                      position="top"
                      offset={10}
                      fill="#e5e7eb"
                      fontSize={sizeLabel}
                      formatter={(val: any) => `${val}건`}
                    />
                  </Bar>

                  {/* Average Dot */}
                  <Scatter dataKey="avg" name="평균" fill="#fbbf24" shape="circle" />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Overlay Count Badges */}
              <div className="absolute top-4 right-4 bg-gray-900/80 p-4 rounded border border-gray-600 text-gray-300 shadow-lg pointer-events-none" style={{ fontSize: `${sizeLabel}px` }}>
                <div className="flex items-center gap-3 mb-2"><span className="w-4 h-4 bg-indigo-500 opacity-60 rounded-sm"></span> 범위 (최저~최고)</div>
                <div className="flex items-center gap-3"><span className="w-4 h-4 bg-yellow-400 rounded-full"></span> 평균</div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-800 bg-gray-850 text-center text-gray-500 shrink-0" style={{ fontSize: `${sizeLabel}px` }}>
          * 데이터는 수집된 항목을 기준으로 자동 산출되었습니다.
        </div>

      </div>
    </div>
  );
};

export default AnalysisModal;

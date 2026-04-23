import React, { useState, useEffect, useRef } from 'react';
import { 
  format, addMonths, subMonths, startOfMonth, endOfMonth, 
  startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay 
} from 'date-fns';
import { ja } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, X, PenLine, Sparkles, BookOpen, ImagePlus, Printer, LayoutGrid, CalendarDays, Check, Trash2, Mic } from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useReactToPrint } from 'react-to-print';
import { auth, db, googleProvider } from './lib/firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';

interface DailyLog {
  good: string;
  bad: string;
  gratitude: string;
  imageUrl?: string;
  images?: string[];
  moodColor?: string;
  aiComment?: string;
}

const MOOD_COLORS = [
  { id: 'none', hex: '', label: '通常' },
  { id: 'calm', hex: '#e8edf2', label: '穏やか' },
  { id: 'warm', hex: '#f5ece9', label: '温かさ' },
  { id: 'focus', hex: '#e3e7d9', label: '集中' },
  { id: 'melancholy', hex: '#ebeaef', label: '物思い' },
];

export default function App() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [logs, setLogs] = useState<Record<string, DailyLog>>({});
  const [monthlyReviews, setMonthlyReviews] = useState<Record<string, string>>({});
  
  // View mode
  const [viewMode, setViewMode] = useState<'calendar' | 'gallery'>('calendar');

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  
  // Modal / Form state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [editForm, setEditForm] = useState<DailyLog>({ good: '', bad: '', gratitude: '', imageUrl: '', images: [], moodColor: '' });

  // Print Ref
  const printRef = useRef<HTMLDivElement>(null);
  
  // AI comment loading state
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isReviewLoading, setIsReviewLoading] = useState(false);

  // Speech Recognition state
  const [recordingField, setRecordingField] = useState<'good' | 'bad' | 'gratitude' | null>(null);
  const recognitionRef = useRef<any>(null);
  const originalTextRef = useRef<string>('');

  // Load from auth & firestore
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
    });
    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!user) {
      setLogs({});
      setMonthlyReviews({});
      return;
    }

    const logsRef = collection(db, `users/${user.uid}/logs`);
    const unsubscribeLogs = onSnapshot(logsRef, (snapshot) => {
      const loadedLogs: Record<string, DailyLog> = {};
      snapshot.forEach((document) => {
        loadedLogs[document.id] = document.data() as DailyLog;
      });
      setLogs(loadedLogs);
    }, (error) => console.error("Firestore logs error:", error));

    const reviewsRef = collection(db, `users/${user.uid}/monthly_reviews`);
    const unsubscribeReviews = onSnapshot(reviewsRef, (snapshot) => {
      const loadedReviews: Record<string, string> = {};
      snapshot.forEach((document) => {
        loadedReviews[document.id] = document.data().reviewText;
      });
      setMonthlyReviews(loadedReviews);
    }, (error) => console.error("Firestore reviews error:", error));

    return () => {
      unsubscribeLogs();
      unsubscribeReviews();
    };
  }, [user]);

  const getLogKey = (date: Date) => format(date, 'yyyy-MM-dd');
  const getMonthKey = (date: Date) => format(date, 'yyyy-MM');

  const getLogForDate = (date: Date): DailyLog | null => {
    return logs[getLogKey(date)] || null;
  };

  const handleOpenEdit = () => {
    const existingLog = getLogForDate(selectedDate);
    setEditForm({ 
      good: existingLog?.good || '', 
      bad: existingLog?.bad || '', 
      gratitude: existingLog?.gratitude || '',
      images: existingLog?.images || (existingLog?.imageUrl ? [existingLog.imageUrl] : []),
      moodColor: existingLog?.moodColor || ''
    });
    setIsModalOpen(true);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    if ((editForm.images?.length || 0) >= 4) {
      alert('写真は最大4枚までです。');
      return;
    }

    const file = files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert('画像は5MB以下のものを選んでください。');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // compress as webp
        const compressedBase64 = canvas.toDataURL('image/webp', 0.8);
        
        setEditForm(prev => {
          const newImages = [...(prev.images || []), compressedBase64].slice(0, 4);
          return { ...prev, images: newImages };
        });
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (indexToRemove: number) => {
    setEditForm(prev => ({
      ...prev,
      images: (prev.images || []).filter((_, idx) => idx !== indexToRemove)
    }));
  };

  // Speech Recognition Handle
  useEffect(() => {
    // stop recording if modal is closed
    if (!isModalOpen && recordingField) {
      recognitionRef.current?.stop();
      setRecordingField(null);
    }
  }, [isModalOpen, recordingField]);

  const toggleRecording = (field: 'good' | 'bad' | 'gratitude') => {
    if (recordingField === field) {
      recognitionRef.current?.stop();
      setRecordingField(null);
      return;
    }

    if (recordingField) {
      recognitionRef.current?.stop();
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('恐れ入りますが、お使いのブラウザは音声入力に対応していません。(Chrome/Safari等を推奨します)');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.continuous = true;
    recognition.interimResults = true;

    originalTextRef.current = editForm[field] || '';

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      // If there's already text, maybe add a line break if we append new dictated text
      // However, making it smooth is better. Just append.
      const newText = originalTextRef.current 
        + (originalTextRef.current && finalTranscript && !originalTextRef.current.endsWith('\n') ? ' ' : '')
        + finalTranscript 
        + interimTranscript;
        
      setEditForm(prev => ({ ...prev, [field]: newText }));

      if (finalTranscript) {
         originalTextRef.current = originalTextRef.current 
           + (originalTextRef.current && !originalTextRef.current.endsWith('\n') ? ' ' : '') 
           + finalTranscript;
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      if (event.error !== 'no-speech') {
        setRecordingField(null);
      }
    };

    recognition.onend = () => {
      setRecordingField(null);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setRecordingField(field);
    } catch (e) {
      console.error(e);
      setRecordingField(null);
    }
  };

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `The_Monthly_Digest_${format(currentMonth, 'yyyy_MM')}`
  });

  const handleSave = async () => {
    if (!user) return;
    const key = getLogKey(selectedDate);
    
    try {
      const logRef = doc(db, `users/${user.uid}/logs`, key);
      await setDoc(logRef, {
        ...editForm,
        ownerId: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
      setIsModalOpen(false);
    } catch (error) {
      console.error("Save failed:", error);
      alert('保存に失敗しました。');
    }
  };

  const handleGetAiComment = async () => {
    const log = getLogForDate(selectedDate);
    if (!log) return;
    
    setIsAiLoading(true);
    try {
      // @ts-ignore
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `以下の日記を読んで、ユーザーを優しく励まし、前向きな気持ちになれるような短いコメント（2〜3文程度）を書いてください。トーンは少し知的で落ち着いた「Editorial」な雰囲気を意識してください。
  
【良かったこと】
${log.good || '特になし'}

【悪かったこと・反省点】
${log.bad || '特になし'}

【感謝すること】
${log.gratitude || '特になし'}
`;
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });
      
      const aiComment = response.text;
      if (aiComment && user) {
        const key = getLogKey(selectedDate);
        const logRef = doc(db, `users/${user.uid}/logs`, key);
        await setDoc(logRef, {
          aiComment,
          ownerId: user.uid,
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
    } catch (e) {
      console.error('AI comment generation failed', e);
      alert('AIコメントの取得に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleGenerateMonthlyReview = async () => {
    if (!user) return;
    setIsReviewLoading(true);
    setIsReviewModalOpen(true);

    try {
      const monthStart = startOfMonth(currentMonth);
      const monthEnd = endOfMonth(monthStart);
      const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
      
      let allLogsText = '';
      daysInMonth.forEach(day => {
        const log = getLogForDate(day);
        if (log && (log.good || log.bad || log.gratitude)) {
          allLogsText += `\n[${format(day, 'yyyy/MM/dd')}]\n`;
          if (log.good) allLogsText += `Good: ${log.good}\n`;
          if (log.bad) allLogsText += `Bad: ${log.bad}\n`;
          if (log.gratitude) allLogsText += `Gratitude: ${log.gratitude}\n`;
        }
      });

      if (!allLogsText.trim()) {
        alert('この月の記録がありません。いくつか日記を書いてから再度お試しください。');
        setIsReviewModalOpen(false);
        setIsReviewLoading(false);
        return;
      }

      // @ts-ignore
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `あなたは著名なライフスタイル雑誌の編集長であり、深い洞察力を持つエッセイストです。
以下の1ヶ月間の日記の記録を読み込み、このユーザーにとって「どんな1ヶ月だったか」を美しく、知的に総括するエディトリアルなレビュー文章（The Monthly Digest）を作成してください。

文章は以下の3つの構成にしてください。
1. **Title**: この1ヶ月を象徴する、抽象的で美しいタイトル（日本語または英語を少し交えたもの）
2. **Overview**: 今月の全体的なハイライトと、そこから見えてくるユーザーの心の動きや成長の総括。（3〜4段落程度。読みやすく流麗な文章で）
3. **Themes of Gratitude**: この月、ユーザーが何度も感謝していたテーマや、幸せを感じていた小さな事柄についての考察。

トーン＆マナー：
- 落ち着いていて、読者に寄り添いつつも「雑誌のエッセイ」のような品格（Editorial Aesthetic）のある文体。
- 過度にポジティブすぎる表現は避け、静かな励ましと深い共感を感じさせること。
- HTMLタグは使わず、自然な箇条書きや改行で構成してください。Markdown記法（#, **など）は使用可能です。

【今月の記録】
${allLogsText}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-pro-preview',
        contents: prompt,
      });

      const reviewText = response.text;
      if (reviewText) {
        const monthId = getMonthKey(currentMonth);
        const reviewRef = doc(db, `users/${user.uid}/monthly_reviews`, monthId);
        await setDoc(reviewRef, {
          reviewText,
          ownerId: user.uid,
          updatedAt: serverTimestamp()
        });
      }
    } catch (e) {
      console.error('Monthly review generation failed', e);
      alert('月間レビューの生成に失敗しました。時間をおいて再度お試しください。');
      setIsReviewModalOpen(false);
    } finally {
      setIsReviewLoading(false);
    }
  };

  // カレンダーの日付リストを生成
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);
  const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

  const selectedLog = getLogForDate(selectedDate);
  const currentMonthReview = monthlyReviews[getMonthKey(currentMonth)];

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-[#fdfcfb] flex items-center justify-center font-sans">
        <p className="text-[#8c8c87] tracking-widest text-[10px] uppercase">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#fdfcfb] text-[#2c2c2c] flex flex-col items-center justify-center font-sans p-6 selection:bg-[#5a5a40] selection:text-white">
        <div className="max-w-md w-full text-center">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-serif italic tracking-tight text-[#1a1a1a] mb-3">The Daily Reflection</h1>
          <p className="text-[10px] uppercase tracking-widest text-[#8c8c87] mb-12">心豊かな暮らしのための空間</p>
          
          <button
            onClick={() => signInWithPopup(auth, googleProvider)}
            className="w-full px-6 py-4 bg-[#1a1a1a] text-white text-[11px] font-bold tracking-widest border border-[#1a1a1a] hover:bg-black transition-colors"
          >
            Googleでログインして始める
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdfcfb] text-[#2c2c2c] p-4 sm:p-6 md:p-10 font-sans selection:bg-[#5a5a40] selection:text-white">
      <div className="max-w-6xl mx-auto">
        {/* Editorial Header */}
        <header className="flex flex-col sm:flex-row justify-between sm:items-baseline mb-8 md:mb-12 border-b border-[#e5e5e0] pb-4 gap-2">
          <div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-serif italic tracking-tight text-[#1a1a1a]">The Daily Reflection</h1>
            <p className="text-[10px] md:text-xs uppercase tracking-widest text-[#8c8c87] mt-1">心豊かな暮らしのための空間</p>
          </div>
          <div className="text-left sm:text-right mt-2 sm:mt-0 flex flex-col sm:items-end gap-2">
            <div>
              <div className="text-sm md:text-base font-medium tracking-wide text-[#1a1a1a]">{format(currentMonth, 'yyyy年 M月')}</div>
              <div className="text-[9px] md:text-[10px] uppercase tracking-widest text-[#8c8c87] mt-1">日々の記録</div>
            </div>
            
            {/* View Toggle & Print Buttons */}
            <div className="flex items-center gap-2 mt-2">
              <div className="flex bg-[#f5f5f0] p-1 rounded-sm border border-[#e5e5e0]">
                <button
                  onClick={() => setViewMode('calendar')}
                  className={`p-1.5 flex items-center justify-center transition-colors ${viewMode === 'calendar' ? 'bg-white shadow-sm text-[#1a1a1a]' : 'text-[#8c8c87] hover:text-[#1a1a1a]'}`}
                  title="Calendar View"
                >
                  <CalendarDays size={14} />
                </button>
                <button
                  onClick={() => setViewMode('gallery')}
                  className={`p-1.5 flex items-center justify-center transition-colors ${viewMode === 'gallery' ? 'bg-white shadow-sm text-[#1a1a1a]' : 'text-[#8c8c87] hover:text-[#1a1a1a]'}`}
                  title="Gallery View"
                >
                  <LayoutGrid size={14} />
                </button>
              </div>

              <button
                onClick={() => handlePrint()}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-[#e5e5e0] text-[#1a1a1a] text-[9px] md:text-[10px] uppercase tracking-widest font-bold hover:bg-[#1a1a1a] hover:text-white transition-colors h-[30px]"
              >
                <Printer size={12} />
                <span>Zine(PDF)を出力</span>
              </button>
            </div>
          </div>
        </header>

        {viewMode === 'gallery' ? (
          <main className="min-h-[500px]">
            <div className="mb-8 flex items-center gap-3">
              <Sparkles size={16} className="text-[#b8860b]" />
              <h2 className="text-xl md:text-2xl font-serif text-[#1a1a1a] tracking-tight">Gratitude Gallery</h2>
              <span className="text-[10px] text-[#8c8c87] uppercase tracking-widest ml-2 hidden sm:inline-block">今月の感謝と写真の記録</span>
            </div>
            
            <div className="columns-1 sm:columns-2 lg:columns-3 gap-6 space-y-6">
              {calendarDays.map(day => {
                const log = getLogForDate(day);
                if (!log || (!log.gratitude && (!log.images || log.images.length === 0))) return null;

                return (
                  <div key={day.toISOString()} className="break-inside-avoid bg-white border border-[#e5e5e0] shadow-sm flex flex-col p-4 cursor-pointer hover:border-[#b8860b] transition-colors" onClick={() => { setSelectedDate(day); setViewMode('calendar'); }}>
                    <div className="text-[10px] tracking-widest text-[#8c8c87] mb-3 border-b border-[#e5e5e0] pb-2">
                      {format(day, 'yyyy/MM/dd')}
                    </div>
                    {log.images && log.images.length > 0 && (
                      <div className="mb-4">
                        <img src={log.images[0]} alt="Gallery feature" className="w-full object-cover bg-[#f5f5f0]" referrerPolicy="no-referrer" />
                      </div>
                    )}
                    {log.gratitude && (
                      <div className="italic font-serif text-[#4a4a30] text-sm leading-relaxed relative">
                        <span className="absolute -top-1 -left-2 text-amber-500/20 text-lg">✦</span>
                        <p className="relative z-10 pl-2 whitespace-pre-wrap">{log.gratitude}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </main>
        ) : (

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12">
          {/* LEFT: Calendar Column */}
          <section className="lg:col-span-5">
            <div className="flex justify-between items-center mb-4 md:mb-6">
              <h2 className="text-lg sm:text-xlg md:text-2xl font-serif tracking-tight text-[#1a1a1a]">日付を選ぶ</h2>
              <div className="flex space-x-3 md:space-x-4">
                <button 
                  onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} 
                  className="text-[#8c8c87] p-1 -m-1 hover:text-[#b8860b] transition-colors"
                >
                  <ChevronLeft size={20} strokeWidth={1.5} />
                </button>
                <button 
                  onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} 
                  className="text-[#8c8c87] p-1 -m-1 hover:text-[#b8860b] transition-colors"
                >
                  <ChevronRight size={20} strokeWidth={1.5} />
                </button>
              </div>
            </div>
            
            <div className="grid grid-cols-7 gap-px bg-[#e5e5e0] border border-[#e5e5e0] rounded-sm overflow-hidden shadow-sm">
              {/* Weekdays */}
              {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (
                <div key={i} className="bg-white py-2 text-center text-[10px] md:text-xs font-bold text-[#8c8c87]">
                  {d}
                </div>
              ))}
              
              {/* Calendar Days */}
              {calendarDays.map((day, idx) => {
                const log = getLogForDate(day);
                const isSelected = isSameDay(day, selectedDate);
                const isCurrentMonth = isSameMonth(day, monthStart);
                const hasGratitude = Boolean(log?.gratitude && log.gratitude.trim() !== '');

                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedDate(day)}
                    className={`
                      relative h-14 sm:h-16 md:h-20 p-1 md:p-2 flex flex-col items-center sm:items-start focus:outline-none transition-all
                      ${!isCurrentMonth ? 'text-[#ccc] bg-white' : 'text-[#1a1a1a] bg-white'}
                      ${isSelected ? 'border-2 border-[#1a1a1a] shadow-lg z-10' : 'border-transparent hover:bg-black/5'}
                      ${hasGratitude && !isSelected && !log?.moodColor ? 'bg-amber-50' : ''}
                    `}
                    style={{ backgroundColor: log?.moodColor || (isSelected ? '#ffffff' : undefined) }}
                  >
                    <span className={`text-xs md:text-sm ${isSelected ? 'font-bold' : ''}`}>
                      {format(day, 'd')}
                    </span>

                    {/* Gratitude Overlay Effect */}
                    {hasGratitude && !isSelected && (
                      <div className="absolute inset-0 bg-amber-50/50 pointer-events-none" />
                    )}

                    {/* Content Markers */}
                    {log && (
                      <div className="absolute bottom-1.5 sm:bottom-2 left-1/2 -translate-x-1/2 flex space-x-1.5 items-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-300" />
                        {hasGratitude && <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                      </div>
                    )}

                    {/* Gratitude large star */}
                    {hasGratitude && (
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-amber-500/20 text-xl md:text-2xl pointer-events-none font-serif">
                        ✦
                      </div>
                    )}

                    {/* Text notification for selected log */}
                    {isSelected && log && (
                      <p className="hidden sm:block absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-blue-600 truncate w-full text-center tracking-tighter">
                        記録済
                      </p>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="mt-4 md:mt-8 flex items-center space-x-4 md:space-x-6">
              <div className="flex items-center space-x-1.5 md:space-x-2 text-[9px] md:text-[10px] tracking-wider text-[#8c8c87]">
                <span className="w-1.5 md:w-2 h-1.5 md:h-2 rounded-full bg-blue-300"></span>
                <span>記録済み</span>
              </div>
              <div className="flex items-center space-x-1.5 md:space-x-2 text-[9px] md:text-[10px] tracking-wider text-[#8c8c87]">
                <span className="w-1.5 md:w-2 h-1.5 md:h-2 rounded-full bg-amber-400"></span>
                <span>感謝の記録</span>
              </div>
            </div>

            {/* Monthly Review Action */}
            <div className="mt-8 pt-6 border-t border-[#e5e5e0]">
              <button
                onClick={() => {
                  if (currentMonthReview) {
                    setIsReviewModalOpen(true);
                  } else {
                    handleGenerateMonthlyReview();
                  }
                }}
                disabled={isReviewLoading}
                className="w-full flex items-center justify-between px-5 md:px-6 py-4 bg-[#fcfaf5] border border-[#e5e5e0] hover:border-[#b8860b] hover:shadow-sm transition-all group"
              >
                <div className="flex items-center gap-3">
                  <BookOpen size={18} className="text-[#8c8c87] group-hover:text-[#b8860b] transition-colors" />
                  <div className="text-left">
                    <div className="text-[11px] md:text-sm font-serif font-bold text-[#1a1a1a]">The Monthly Digest</div>
                    <div className="text-[9px] md:text-[10px] text-[#8c8c87] mt-0.5">今月の振り返りを読む</div>
                  </div>
                </div>
                <div className="text-[10px] uppercase font-bold tracking-widest text-[#5a5a40]">
                  {isReviewLoading ? '生成中...' : (currentMonthReview ? 'View' : 'Generate')}
                </div>
              </button>
            </div>
          </section>

          {/* RIGHT: Entry Read-only Column */}
          <section className="lg:col-span-7 bg-white p-5 md:p-10 border border-[#e5e5e0] shadow-sm flex flex-col justify-between lg:min-h-[560px]">
            {/* The printable wrapper for the right section */}
            <div ref={printRef} className="print:p-8 print:bg-white flex-1">
              <div className="flex justify-between items-start mb-6 md:mb-12 print:mb-8">
                <div>
                  <span className="text-[10px] tracking-[0.2em] text-[#8c8c87]">{format(selectedDate, 'EEEE', { locale: ja })}</span>
                  <div className="flex items-center gap-3">
                    <h3 className="text-2xl sm:text-3xl md:text-5xl font-serif mt-1 text-[#1a1a1a] tracking-tight">{format(selectedDate, 'yyyy年 M月 d日', { locale: ja })}</h3>
                    {selectedLog?.moodColor && (
                      <div className="w-4 h-4 rounded-full border border-[#1a1a1a]/20 shrink-0 mt-2" style={{ backgroundColor: selectedLog.moodColor }} title="Today's mood" />
                    )}
                  </div>
                </div>
                <button
                  onClick={handleOpenEdit}
                  className="bg-[#5a5a40] text-white p-3 md:p-4 rounded-full w-10 h-10 md:w-14 md:h-14 flex items-center justify-center cursor-pointer hover:bg-[#4a4a30] transition-colors shadow-sm flex-shrink-0 print:hidden"
                  title="Edit Entry"
                >
                  <PenLine size={16} />
                </button>
              </div>

              {selectedLog?.images && selectedLog.images.length > 0 && (
                <div className={`mb-6 w-full grid gap-2 ${selectedLog.images.length === 1 ? 'grid-cols-1' : selectedLog.images.length === 2 ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'} print:mb-8 print:break-inside-avoid print:grid-cols-2`}>
                  {selectedLog.images.map((img, i) => (
                    <div key={i} className="aspect-video sm:aspect-square md:aspect-video lg:aspect-square overflow-hidden bg-[#f5f5f0] flex items-center justify-center border border-[#e5e5e0]">
                      <img src={img} alt={`Today's memory ${i+1}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-6 md:space-y-8">
                <div>
                  <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] block mb-2">
                    良かったこと (Good)
                  </label>
                  <div className="w-full border-b border-[#eee] py-2 md:py-3 text-[14px] md:text-[15px] italic font-serif min-h-[40px] text-[#2c2c2c] leading-relaxed break-words whitespace-pre-wrap">
                    {selectedLog?.good || <span className="text-[#ccc]">記録がありません。</span>}
                  </div>
                </div>
                
                <div>
                  <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] block mb-2">
                    反省点・学び (Bad)
                  </label>
                  <div className="w-full border-b border-[#eee] py-2 md:py-3 text-[14px] md:text-[15px] italic font-serif min-h-[40px] text-[#2c2c2c] leading-relaxed break-words whitespace-pre-wrap">
                    {selectedLog?.bad || <span className="text-[#ccc]">記録がありません。</span>}
                  </div>
                </div>

                <div className="relative print:break-inside-avoid">
                  <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#b8860b] block mb-2">
                    今日の感謝 (Gratitude)
                  </label>
                  <div className="w-full border border-[#f3e5ab] bg-[#fffdf0] px-4 md:px-5 py-3 md:py-4 text-[14px] md:text-[15px] italic font-serif min-h-[60px] text-[#4a4a30] leading-relaxed relative break-words shadow-sm whitespace-pre-wrap">
                    <span className="absolute top-2 right-3 text-amber-500/40 text-lg leading-none font-serif">✦</span>
                    {selectedLog?.gratitude || <span className="text-amber-700/40">感謝の記録がありません。</span>}
                  </div>
                </div>
              </div>
            </div>

            {/* AI Insights Area */}
            {(selectedLog?.good || selectedLog?.bad || selectedLog?.gratitude) && (
              <div className="mt-8 pt-6 md:pt-8 border-t border-[#f0f0f0] print:hidden">
                {selectedLog.aiComment ? (
                  <div className="bg-[#fcfaf5] border border-[#e5e5e0] p-5 md:p-6 shadow-sm relative mt-2">
                    <div className="flex items-center gap-1.5 md:gap-2 mb-3">
                      <Sparkles size={14} className="text-[#b8860b]" />
                      <span className="text-[9px] md:text-[10px] uppercase tracking-widest font-bold text-[#b8860b]">Gemini Insight</span>
                    </div>
                    <p className="text-[14px] md:text-[15px] leading-relaxed text-[#4a4a30] italic font-serif">
                      "{selectedLog.aiComment}"
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex-1 pr-0 sm:pr-6">
                      <p className="text-[11px] md:text-xs text-[#8c8c87] italic mb-1 font-serif">AIがあなたの記録を読んで、励ましのメッセージを贈ります。</p>
                      <span className="text-[9px] uppercase tracking-widest font-bold text-[#1a1a1a]">Gemini Insight</span>
                    </div>
                    <button
                      onClick={handleGetAiComment}
                      disabled={isAiLoading}
                      className="w-full sm:w-auto px-5 py-3 bg-[#fdfcfb] border border-[#1a1a1a] text-[10px] font-bold tracking-widest hover:bg-[#1a1a1a] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {isAiLoading ? '考え中...' : 'AIからメッセージをもらう'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>
        )}

        <footer className="mt-12 md:mt-16 mb-4 flex flex-col sm:flex-row justify-between items-center gap-2 text-[9px] md:text-[10px] tracking-widest text-[#8c8c87]">
          <div className="flex items-center gap-4">
            <span>ユーザー: {user?.displayName}</span>
            <button onClick={() => signOut(auth)} className="hover:text-[#1a1a1a] transition-colors underline decoration-[#e5e5e0] underline-offset-4">ログアウト</button>
          </div>
          <div>© {format(new Date(), 'yyyy')} Reflections Studio</div>
        </footer>
      </div>

      {/* Editor Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed justify-center z-50 flex items-center inset-0 p-3 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsModalOpen(false)}
              className="absolute inset-0 bg-[#2c2c2c]/40 backdrop-blur-sm"
            />
            
            <motion.div 
              initial={{ scale: 0.98, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.98, opacity: 0, y: 10 }}
              className="bg-[#fdfcfb] rounded-sm border border-[#1a1a1a] p-5 md:p-10 w-full max-w-2xl relative z-10 max-h-[95vh] flex flex-col shadow-2xl"
            >
              <div className="flex justify-between items-center mb-6 pb-4 border-b border-[#e5e5e0]">
                <h3 className="text-xl md:text-3xl font-serif tracking-tight text-[#1a1a1a]">
                  {format(selectedDate, 'yyyy年 M月 d日', { locale: ja })}
                </h3>
                <button 
                  onClick={() => setIsModalOpen(false)}
                  className="p-2 -mr-2 text-[#8c8c87] hover:bg-[#e5e5e0] hover:text-[#1a1a1a] rounded-sm transition-colors"
                >
                  <X size={20} strokeWidth={1.5} />
                </button>
              </div>

              <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar flex-1 pb-4">
                
                {/* Mood Selection */}
                <div>
                  <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] block mb-3">
                    今日の気分 (Mood Palette)
                  </label>
                  <div className="flex gap-4 items-center">
                    {MOOD_COLORS.map(mood => (
                      <button
                        key={mood.id}
                        type="button"
                        title={mood.label}
                        onClick={() => setEditForm(prev => ({ ...prev, moodColor: mood.hex }))}
                        className={`w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all ${editForm.moodColor === mood.hex ? 'border-[#1a1a1a] scale-110 shadow-md' : 'border-transparent hover:scale-105 shadow-sm'}`}
                        style={{ backgroundColor: mood.hex || '#ffffff', outline: mood.hex ? 'none' : '1px solid #e5e5e0' }}
                      >
                        {editForm.moodColor === mood.hex && <Check size={14} className="text-[#1a1a1a]/60" />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Multiple Image Upload */}
                <div>
                  <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] flex items-center gap-1.5 mb-2">
                    <ImagePlus size={14} /> 
                    <span>今日の写真 ({editForm.images?.length || 0}/4枚)</span>
                  </label>
                  
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    {editForm.images?.map((img, idx) => (
                      <div key={idx} className="relative w-full aspect-square bg-[#f5f5f0] border border-[#e5e5e0] group">
                        <img src={img} className="w-full h-full object-cover" alt={`Entry photo ${idx}`} referrerPolicy="no-referrer" />
                        <button 
                          onClick={() => removeImage(idx)}
                          className="absolute top-1 right-1 p-1.5 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-black"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    
                    {(!editForm.images || editForm.images.length < 4) && (
                      <label className="w-full aspect-square bg-[#fdfcfb] border border-dashed border-[#ccc] flex flex-col items-center justify-center text-[#8c8c87] hover:border-[#1a1a1a] hover:text-[#1a1a1a] transition-colors cursor-pointer">
                        <ImagePlus size={20} className="mb-1 opacity-50" />
                        <span className="text-[10px] font-serif italic hidden sm:inline">追加する</span>
                        <input type="file" accept="image/jpeg, image/png, image/webp" className="hidden" onChange={handleImageUpload} />
                      </label>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] block">
                      良かったこと (Good)
                    </label>
                    <button
                      type="button"
                      onClick={() => toggleRecording('good')}
                      className={`p-1.5 rounded-full transition-colors flex items-center justify-center gap-1.5 ${recordingField === 'good' ? 'bg-red-50 text-red-500' : 'text-[#8c8c87] hover:bg-[#f5f5f0] hover:text-[#1a1a1a]'}`}
                      title={recordingField === 'good' ? "録音停止" : "音声で入力"}
                    >
                      {recordingField === 'good' && <span className="text-[9px] uppercase tracking-widest font-bold animate-pulse">Listening...</span>}
                      <Mic size={14} className={recordingField === 'good' ? 'animate-pulse' : ''} />
                    </button>
                  </div>
                  <textarea
                    value={editForm.good}
                    onChange={(e) => {
                      setEditForm(prev => ({ ...prev, good: e.target.value }));
                      if (recordingField === 'good') originalTextRef.current = e.target.value;
                    }}
                    placeholder="今日、笑顔になれたことは何ですか？"
                    className="w-full border-b border-[#e5e5e0] focus:border-[#5a5a40] bg-transparent outline-none py-2 md:py-3 text-[15px] md:text-base italic font-serif min-h-[70px] resize-none text-[#2c2c2c] transition-colors placeholder:text-[#ccc]"
                  />
                </div>
                
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#1a1a1a] block">
                      反省点・学び (Bad)
                    </label>
                    <button
                      type="button"
                      onClick={() => toggleRecording('bad')}
                      className={`p-1.5 rounded-full transition-colors flex items-center justify-center gap-1.5 ${recordingField === 'bad' ? 'bg-red-50 text-red-500' : 'text-[#8c8c87] hover:bg-[#f5f5f0] hover:text-[#1a1a1a]'}`}
                      title={recordingField === 'bad' ? "録音停止" : "音声で入力"}
                    >
                      {recordingField === 'bad' && <span className="text-[9px] uppercase tracking-widest font-bold animate-pulse">Listening...</span>}
                      <Mic size={14} className={recordingField === 'bad' ? 'animate-pulse' : ''} />
                    </button>
                  </div>
                  <textarea
                    value={editForm.bad}
                    onChange={(e) => {
                      setEditForm(prev => ({ ...prev, bad: e.target.value }));
                      if (recordingField === 'bad') originalTextRef.current = e.target.value;
                    }}
                    placeholder="改善したいことや、学んだことは？"
                    className="w-full border-b border-[#e5e5e0] focus:border-[#5a5a40] bg-transparent outline-none py-2 md:py-3 text-[15px] md:text-base italic font-serif min-h-[70px] resize-none text-[#2c2c2c] transition-colors placeholder:text-[#ccc]"
                  />
                </div>

                <div className="relative">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] md:text-[11px] font-bold tracking-widest text-[#b8860b] block relative p-1 outline outline-1 outline-offset-2 outline-[#f3e5ab] bg-[#fffdf0] rounded-sm max-w-max">
                      <span className="text-amber-500 absolute -top-1.5 -left-1 text-[10px]">✦</span>
                      <span className="pl-2">今日の感謝 (Gratitude)</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => toggleRecording('gratitude')}
                      className={`p-1.5 rounded-full transition-colors flex items-center justify-center gap-1.5 ${recordingField === 'gratitude' ? 'bg-amber-100 text-amber-600' : 'text-[#b8860b] hover:bg-amber-50 hover:text-amber-600'}`}
                      title={recordingField === 'gratitude' ? "録音停止" : "音声で入力"}
                    >
                      {recordingField === 'gratitude' && <span className="text-[9px] uppercase tracking-widest font-bold animate-pulse text-amber-600">Listening...</span>}
                      <Mic size={14} className={recordingField === 'gratitude' ? 'animate-pulse' : ''} />
                    </button>
                  </div>
                  <textarea
                    value={editForm.gratitude}
                    onChange={(e) => {
                      setEditForm(prev => ({ ...prev, gratitude: e.target.value }));
                      if (recordingField === 'gratitude') originalTextRef.current = e.target.value;
                    }}
                    placeholder="誰かに感謝したいことや、小さな幸せを記録..."
                    className="w-full border border-[#f3e5ab] bg-[#fffdf0] focus:border-[#b8860b] shadow-sm outline-none px-3 md:px-4 py-3 md:py-4 text-[15px] md:text-base italic font-serif min-h-[90px] resize-none text-[#4a4a30] transition-colors placeholder:text-amber-700/30"
                  />
                  <span className="absolute top-8 right-3 text-amber-500/40 text-xl font-serif pointer-events-none hidden md:block">✦</span>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3 md:gap-4 pt-5 md:pt-6 border-t border-[#e5e5e0]">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 md:px-6 py-2.5 md:py-3 text-[10px] font-bold tracking-widest text-[#8c8c87] hover:text-[#1a1a1a] transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 md:px-6 py-2.5 md:py-3 bg-[#1a1a1a] text-white text-[10px] font-bold tracking-widest border border-[#1a1a1a] hover:bg-black transition-colors"
                >
                  保存する
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Review Modal */}
      <AnimatePresence>
        {isReviewModalOpen && (
          <div className="fixed justify-center z-50 flex items-center inset-0 p-3 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsReviewModalOpen(false)}
              className="absolute inset-0 bg-[#fdfcfb]/90 backdrop-blur-md"
            />
            
            <motion.div 
              initial={{ scale: 0.98, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.98, opacity: 0, y: 20 }}
              className="bg-white rounded-sm border border-[#e5e5e0] p-6 md:p-12 w-full max-w-3xl relative z-10 max-h-[90vh] flex flex-col shadow-2xl overflow-y-auto custom-scrollbar"
            >
              <button 
                onClick={() => setIsReviewModalOpen(false)}
                className="absolute top-4 right-4 md:top-8 md:right-8 p-2 text-[#8c8c87] hover:text-[#1a1a1a] transition-colors"
              >
                <X size={24} strokeWidth={1} />
              </button>

              <div className="text-center mb-10 border-b border-[#e5e5e0] pb-8 mt-4">
                <span className="text-[10px] tracking-[0.3em] uppercase text-[#b8860b] font-bold">The Monthly Digest</span>
                <h2 className="text-3xl md:text-5xl font-serif mt-4 text-[#1a1a1a] tracking-tight">{format(currentMonth, 'yyyy年 M月')}の総括</h2>
                <div className="flex justify-center items-center gap-2 mt-6">
                  <Sparkles size={16} className="text-[#8c8c87]" />
                  <span className="text-[9px] uppercase tracking-widest text-[#8c8c87]">Curated by Gemini</span>
                  <Sparkles size={16} className="text-[#8c8c87]" />
                </div>
              </div>

              {isReviewLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-[#8c8c87]">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                  >
                    <BookOpen size={32} className="opacity-50" />
                  </motion.div>
                  <p className="mt-6 text-sm font-serif italic">今月の記録を読み解いています...</p>
                </div>
              ) : (
                <div className="prose prose-sm md:prose-base max-w-none prose-headings:font-serif prose-headings:font-normal prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:text-[#b8860b] prose-p:text-[#4a4a30] prose-p:leading-loose mx-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentMonthReview || '記録がありません。'}
                  </ReactMarkdown>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Hidden Print Area -> Full Zine Monthly Output */}
      <div className="hidden">
        <div ref={printRef} className="print:block w-full min-h-screen bg-[#fdfcfb] text-[#1a1a1a]">
          {/* Cover Page */}
          <div className="page-break-after-always flex flex-col items-center justify-center min-h-[95vh] text-center p-12">
            <div className="mb-12">
              <span className="text-[10px] tracking-[0.4em] uppercase text-[#8c8c87] font-bold">The Monthly Digest</span>
            </div>
            <h1 className="text-5xl font-serif mt-4 text-[#1a1a1a] tracking-tight mb-6">{format(currentMonth, 'yyyy年 M月')}</h1>
            
            <div className="w-24 h-px bg-[#e5e5e0] my-8 mx-auto" />
            
            {currentMonthReview ? (
              <div className="prose prose-sm max-w-2xl mx-auto text-left prose-headings:font-serif prose-headings:text-center prose-h1:text-2xl prose-h2:text-xl prose-p:text-[#4a4a30] prose-p:leading-loose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentMonthReview}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="font-serif italic text-[#8c8c87] mt-12">No review generated for this month.</p>
            )}
          </div>

          {/* Daily Entries Pages */}
          <div className="p-8 space-y-16">
            {calendarDays.map(day => {
              const log = getLogForDate(day);
              if (!log || (!log.good && !log.bad && !log.gratitude && (!log.images || log.images.length === 0))) return null;

              return (
                <div key={day.toISOString()} className="page-break-inside-avoid border-t border-[#e5e5e0] pt-8">
                  <div className="mb-6 flex items-center gap-4">
                    <h2 className="text-3xl font-serif tracking-tight">{format(day, 'MM/dd')}</h2>
                    <span className="text-[10px] tracking-[0.2em] text-[#8c8c87] uppercase">{format(day, 'EEEE', { locale: ja })}</span>
                    {log.moodColor && (
                      <div className="w-5 h-5 rounded-full border border-[#1a1a1a]/20" style={{ backgroundColor: log.moodColor }} />
                    )}
                  </div>

                  {log.images && log.images.length > 0 && (
                    <div className={`grid gap-4 mb-8 ${log.images.length === 1 ? 'grid-cols-1 max-w-2xl' : 'grid-cols-2'}`}>
                      {log.images.map((img, i) => (
                        <div key={i} className="aspect-[4/3] bg-[#f5f5f0] overflow-hidden border border-[#e5e5e0]">
                          <img src={img} alt="Snapshot" className="w-full h-full object-cover" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-8">
                    {log.good && (
                      <div>
                        <h4 className="text-[9px] uppercase tracking-widest text-[#8c8c87] mb-2 font-bold">Good</h4>
                        <p className="font-serif italic text-sm leading-relaxed text-[#2c2c2c] whitespace-pre-wrap">{log.good}</p>
                      </div>
                    )}
                    {log.bad && (
                      <div>
                        <h4 className="text-[9px] uppercase tracking-widest text-[#8c8c87] mb-2 font-bold">Bad</h4>
                        <p className="font-serif italic text-sm leading-relaxed text-[#2c2c2c] whitespace-pre-wrap">{log.bad}</p>
                      </div>
                    )}
                    {log.gratitude && (
                      <div className="col-span-2 mt-4 bg-[#fffdf0] border border-[#f3e5ab] p-6 relative">
                        <span className="absolute top-4 right-4 text-amber-500/30 text-2xl font-serif">✦</span>
                        <h4 className="text-[9px] uppercase tracking-widest text-[#b8860b] mb-2 font-bold">Gratitude</h4>
                        <p className="font-serif italic text-sm leading-relaxed text-[#4a4a30] whitespace-pre-wrap">{log.gratitude}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      
    </div>
  );
}


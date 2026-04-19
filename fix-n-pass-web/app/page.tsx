'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  UploadCloud, FileText, CheckCircle, AlertCircle, 
  Loader2, Square, CheckSquare, ArrowRight, Info 
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useRouter } from 'next/navigation';

export default function IntroPage() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isRequesting, setIsRequesting] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  
  const router = useRouter();

  useEffect(() => {
    const getUser = async () => {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      setUser(currentUser);
      if (currentUser?.id) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", currentUser.id)
          .single();
        const r = profile?.role || null;
        setRole(r);
        if (r === "contractor") {
          router.replace("/contractor/market");
        }
      } else {
        setRole(null);
      }
    };
    getUser();
  }, [router]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) setFile(acceptedFiles[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
  });

  const handleUpload = async () => {
    if (!file) return;
    if (role === "contractor") {
      alert("수리업체 계정은 수리 의뢰를 등록할 수 없습니다.");
      router.push("/contractor/market");
      return;
    }
    setIsUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const query = user?.id ? `?requester_id=${encodeURIComponent(user.id)}` : '';

    try {
      const res = await fetch(`${baseUrl}/api/upload-pdf${query}`, {
        method: 'POST',
        body: formData,
      });

      // 진짜 에러 내용을 파악하기 위해 텍스트로 추출합니다.
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`백엔드 응답 오류(${res.status}): ${errText}`);
      }

      const result = await res.json();
      setAnalysisResult(result.data);
      
      if (result.data.parsed_data?.mandatory) {
        setSelectedItems([...result.data.parsed_data.mandatory]);
      }
    } catch (error: any) {
      console.error('Upload error:', error);
      // 뭉뚱그린 에러 대신 정확한 에러를 띄웁니다.
      alert(error.message || '분석 중 에러가 발생했습니다.');
    } finally {
      setIsUploading(false);
    }
  };

  const toggleItem = (item: string) => {
    setSelectedItems(prev => 
      prev.includes(item) ? prev.filter(i => i !== item) : [...prev, item]
    );
  };

  const toggleAll = () => {
    if (!analysisResult) return;
    const allItems = [
      ...(analysisResult.parsed_data.mandatory || []),
      ...(analysisResult.parsed_data.optional || [])
    ];
    
    if (selectedItems.length === allItems.length) {
      setSelectedItems([]);
    } else {
      setSelectedItems(allItems);
    }
  };

  const handleFinalRequest = async () => {
    if (!analysisResult || !analysisResult.repair_request_id) {
      alert("데이터 식별 오류입니다. 새로고침 후 다시 시도해주세요.");
      return;
    }
    if (!user?.id) {
      alert('견적 요청 접수를 위해 로그인/회원가입이 필요합니다.');
      router.push('/login');
      return;
    }
    
    setIsRequesting(true);
    
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      
      const res = await fetch(`${baseUrl}/api/update-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repair_request_id: analysisResult.repair_request_id,
          requester_id: user.id,
          selected_items: selectedItems,
          status: 'requested'
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.detail || '업데이트 실패');
      }
      
      alert('성공적으로 견적 요청이 완료되었습니다.\n\n견적 요청 마감 기한은 2주입니다.');
      router.push('/my-requests');
      
    } catch (error: any) {
      console.error('Final request error:', error);
      alert(`요청 중 오류가 발생했습니다: ${error.message}`);
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans">
      <main className="max-w-4xl mx-auto pt-20 pb-10 px-6">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-extrabold text-blue-600 mb-2 tracking-tight">Fix&Pass</h1>
          <p className="text-lg text-slate-500 font-medium">기계식 주차장 안전검사 AI 분석 및 견적 비교</p>
        </header>

        {!analysisResult ? (
          <section className="bg-slate-50 border border-slate-200 rounded-3xl p-10 shadow-sm text-center">
            <div {...getRootProps()} className={`border-2 border-dashed rounded-2xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-slate-400 bg-white'}`}>
              <input {...getInputProps()} />
              <UploadCloud className={`w-12 h-12 mb-4 ${isDragActive ? 'text-blue-500' : 'text-slate-400'}`} />
              {file ? (
                <div className="flex items-center gap-2 text-blue-600 font-bold">
                  <FileText className="w-5 h-5" /> {file.name}
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-slate-700 font-bold">검사 결과서(PDF)를 여기에 끌어다 놓으세요</p>
                </div>
              )}
            </div>
            
            <button onClick={handleUpload} disabled={!file || isUploading} className="w-full mt-8 bg-slate-900 text-white py-4 rounded-xl font-bold text-lg hover:bg-slate-800 disabled:bg-slate-300 flex items-center justify-center gap-2">
              {isUploading ? <><Loader2 className="w-6 h-6 animate-spin" /> AI 분석 진행 중...</> : '분석 시작하기'}
            </button>
          </section>
        ) : (
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-xl">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle className="w-7 h-7" />
                  <h2 className="text-2xl font-extrabold">검사 결과 분석 완료</h2>
                </div>
                <button onClick={toggleAll} className="text-sm font-bold text-blue-600 hover:underline px-4 py-2 bg-blue-50 rounded-lg">
                  {selectedItems.length === ((analysisResult.parsed_data.mandatory?.length || 0) + (analysisResult.parsed_data.optional?.length || 0)) ? '전체 해제' : '전체 선택'}
                </button>
              </div>

              <div className="bg-slate-50 p-6 rounded-2xl mb-10 flex justify-between items-center border border-slate-100">
                <div>
                  <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mb-1">건물 및 주차장 정보</p>
                  <div className="flex items-center gap-3 mb-1">
                    <p className="font-black text-xl text-slate-900">{analysisResult.building_name}</p>
                    {analysisResult.parking_type && (
                      <span className="px-3 py-1 bg-indigo-100 text-indigo-700 text-xs font-bold rounded-full border border-indigo-200">
                        {analysisResult.parking_type}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-600 font-medium">{analysisResult.region_summary}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mb-1">선택된 견적 항목</p>
                  <p className="font-black text-2xl text-blue-600">{selectedItems.length} <span className="text-sm text-slate-400">건</span></p>
                </div>
              </div>

              {analysisResult.parsed_data.mandatory?.length > 0 && (
                <div className="space-y-4 mb-8">
                  <h3 className="flex items-center gap-2 text-red-600 font-black text-lg mb-2">
                    <AlertCircle className="w-6 h-6" /> 부적합 항목 <span className="text-sm font-medium text-red-400">(운영을 위해 수리 필수)</span>
                  </h3>
                  <div className="grid gap-3">
                    {analysisResult.parsed_data.mandatory.map((item: string, i: number) => (
                      <div key={`man-${i}`} onClick={() => toggleItem(item)} className={`flex items-start gap-4 p-4 rounded-2xl border-2 cursor-pointer transition-all ${selectedItems.includes(item) ? 'border-red-500 bg-red-50' : 'border-slate-100 bg-white'}`}>
                        <div className="mt-0.5">
                          {selectedItems.includes(item) ? <CheckSquare className="w-6 h-6 text-red-600 shrink-0" /> : <Square className="w-6 h-6 text-slate-200 shrink-0" />}
                        </div>
                        <span className={`text-base leading-relaxed ${selectedItems.includes(item) ? 'text-red-900 font-bold' : 'text-slate-600'}`}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysisResult.parsed_data.optional?.length > 0 && (
                <div className="space-y-4 mb-8">
                  <h3 className="flex items-center gap-2 text-blue-600 font-black text-lg mb-2">
                    <Info className="w-6 h-6" /> 권고 항목 <span className="text-sm font-medium text-blue-400">(이번 기회에 함께 수리하면 좋습니다)</span>
                  </h3>
                  <div className="grid gap-3">
                    {analysisResult.parsed_data.optional.map((item: string, i: number) => (
                      <div key={`opt-${i}`} onClick={() => toggleItem(item)} className={`flex items-start gap-4 p-4 rounded-2xl border-2 cursor-pointer transition-all ${selectedItems.includes(item) ? 'border-blue-500 bg-blue-50' : 'border-slate-100 bg-white'}`}>
                        <div className="mt-0.5">
                          {selectedItems.includes(item) ? <CheckSquare className="w-6 h-6 text-blue-600 shrink-0" /> : <Square className="w-6 h-6 text-slate-200 shrink-0" />}
                        </div>
                        <span className={`text-base leading-relaxed ${selectedItems.includes(item) ? 'text-blue-900 font-bold' : 'text-slate-600'}`}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 font-medium leading-relaxed">
                견적 요청 마감 기한은 <span className="font-black">2주</span>입니다.
              </div>

              <button 
                onClick={handleFinalRequest}
                disabled={selectedItems.length === 0 || isRequesting} 
                className="w-full mt-4 bg-slate-900 text-white py-5 rounded-2xl font-black text-xl hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400 transition-all shadow-xl flex items-center justify-center gap-2"
              >
                {isRequesting ? <><Loader2 className="w-6 h-6 animate-spin" /> 요청 전송 중...</> : <>{selectedItems.length}개 항목 최종 견적 요청하기 <ArrowRight className="w-6 h-6" /></>}
              </button>
              {!user?.id && (
                <p className="text-center text-sm text-slate-500 mt-3">
                  PDF 분석은 비회원도 가능하며, 최종 견적 요청 시 로그인/회원가입이 필요합니다.
                </p>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
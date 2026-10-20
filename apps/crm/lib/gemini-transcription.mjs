// The feature-enabled file API accepts at most 15 minutes. Keep chunks below that
// limit, retain exact offsets, and never assume speaker IDs survive a chunk boundary.
export const CHUNK_MS=840000;
export function chunkPlan(duration){
  if(!Number.isSafeInteger(duration)||duration<=0)throw new Error('Invalid audio duration');
  return Array.from({length:Math.ceil(duration/CHUNK_MS)},(_,index)=>({index,start_ms:index*CHUNK_MS,duration_ms:Math.min(CHUNK_MS,duration-index*CHUNK_MS)}));
}
function offset(value){
  if(typeof value==='string'&&/^\d+(\.\d+)?s$/.test(value))return Math.round(Number(value.slice(0,-1))*1000);
  throw new Error('Gemini response is missing word timestamps');
}
export function parseGeminiChunk(response,chunk,multiple=false){
  const candidates=response.candidates;
  if(candidates?.length!==1||candidates[0].finishReason!=='STOP')throw new Error('Gemini did not return a complete transcription');
  const parts=candidates[0].content?.parts;
  if(!Array.isArray(parts)||!parts.length)throw new Error('Gemini returned no transcription parts');
  const segments=[];
  for(const part of parts){
    const tx=part.audioTranscription;
    const text=String(tx?.text??part.text??'').trim();
    if(!text)continue;
    if(!tx||!Array.isArray(tx.words)||!tx.words.length)throw new Error('Gemini speech is missing timestamped words');
    const words=tx.words.map(w=>({start:offset(w.startOffset),end:offset(w.endOffset)}));
    for(const w of words){
      // Experimental timing sometimes puts a word's end before its start. Its
      // duration is unknown: use the supplied onset, never invent a positive span.
      // Raw offsets and correction counts remain available in the run provenance.
      if(w.end<w.start)w.end=w.start;
      if(w.start<0||w.end<w.start||w.end>chunk.duration_ms+2000||w.start>chunk.duration_ms)throw new Error('Gemini returned invalid word timing');
    }
    // Provider turns can overlap; preserve turn text and sort by its first word.
    const start=Math.min(...words.map(w=>w.start)),end=Math.min(chunk.duration_ms,Math.max(...words.map(w=>w.end)));
    const label=tx.speakerLabel;
    segments.push({start_ms:chunk.start_ms+start,end_ms:chunk.start_ms+end,speaker:label?`${multiple?`Part ${chunk.index+1} / `:''}${label}`:null,transcript:text,confidence:null});
  }
  return segments.sort((a,b)=>a.start_ms-b.start_ms);
}
export function parseGemini(data,expectedDurationMs){
  if(data.provider!=='google'||data.audio_duration_ms!==Number(expectedDurationMs))throw new Error('Gemini audio duration does not match the full recording');
  const plan=chunkPlan(Number(expectedDurationMs));
  if(data.chunks?.length!==plan.length)throw new Error('Missing Gemini audio chunks');
  const segments=[];
  const models=[];
  for(let i=0;i<plan.length;i++){
    const actual=data.chunks[i],expected=plan[i];
    if(actual.index!==i||actual.start_ms!==expected.start_ms||actual.duration_ms!==expected.duration_ms||!actual.audio?.sha256||!actual.audio?.generation)throw new Error('Gemini chunk coverage or provenance mismatch');
    segments.push(...parseGeminiChunk(actual.response,expected,plan.length>1));
    const words=actual.response.candidates[0].content.parts.flatMap(p=>p.audioTranscription?.words||[]);
    models.push({part:i+1,model:actual.response.modelVersion,responseId:actual.response.responseId,usage:actual.response.usageMetadata,audio:actual.audio,
      timing_corrections:words.filter(w=>offset(w.endOffset)<offset(w.startOffset)).length});
  }
  segments.forEach((s,i)=>s.sequence=i);
  return {duration:Number(expectedDurationMs),segments,modelInfo:{chunks:models,speakers_scoped_per_chunk:plan.length>1,options:data.options},requestId:null};
}

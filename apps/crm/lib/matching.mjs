const parsed=v=>typeof v==='string'?JSON.parse(v):v||{};
const millis=v=>Date.parse(v);
const url=value=>{try{const u=new URL(value);return u.origin+u.pathname.replace(/\/$/,'');}catch{return null;}};

// These are derived calendar associations, never claims that an attendee spoke.
export function automaticMeeting(recording,meetings){
  const metadata=parsed(recording.metadata),start=millis(recording.occurred_at),end=millis(recording.ends_at);
  const eventId=metadata['portomatic-calendar-event-id']||metadata.calendar_event_id;
  const calendarId=metadata['portomatic-calendar-id']||metadata.calendar_id;
  const conference=url(metadata['portomatic-meeting-url']||metadata.meeting_url);
  const matches=[];
  for(const meeting of meetings){
    if(meeting.cancelled||meeting.all_day||recording.rejected?.includes(meeting.id))continue;
    const meetingStart=millis(meeting.occurred_at),meetingEnd=millis(meeting.ends_at);
    const delta=Math.abs(start-meetingStart)/60000;
    let score=0,evidence=[];
    if(eventId&&eventId===meeting.external_id&&(!calendarId||calendarId===meeting.account)){
      score=1;evidence=['Exact calendar event ID supplied with the recording'];
    }else if(conference&&(meeting.urls||[]).map(url).includes(conference)){
      if(delta>20)continue;
      score=.99;evidence=['Exact meeting URL supplied with the recording','Recording and meeting start within 20 minutes'];
    }else if(recording.owner_id&&recording.owner_id===meeting.owner_id&&/Screen Recording \d{4}-\d{2}-\d{2} at /i.test(recording.filename||'')){
      const overlap=Math.max(0,Math.min(end,meetingEnd)-Math.max(start,meetingStart));
      const shorter=Math.min(end-start,meetingEnd-meetingStart);
      if(delta<=5&&shorter>=60000&&overlap/shorter>=.5){
        score=.9;evidence=['Same founder','Local capture timestamp within five minutes of the meeting start','At least half of the shorter interval overlaps'];
      }
    }
    if(score)matches.push({meeting,score,evidence,delta});
  }
  matches.sort((a,b)=>b.score-a.score||a.delta-b.delta||a.meeting.id.localeCompare(b.meeting.id));
  if(!matches.length)return null;
  const best=matches[0];
  // The same event may be visible in both founders' calendars.
  const eventKey=m=>`${m.external_id}:${m.occurred_at}`;
  if(matches.slice(1).some(m=>m.score===best.score&&eventKey(m.meeting)!==eventKey(best.meeting)))return null;
  return {meetingId:best.meeting.id,score:best.score,evidence:best.evidence};
}

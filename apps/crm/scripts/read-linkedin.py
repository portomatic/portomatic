import csv,io,json,sys,zipfile,os

def read_table(text,connections=False):
    lines=text.splitlines(keepends=True)
    if connections:
        header=next((i for i,line in enumerate(lines) if line.startswith('First Name,Last Name,')),None)
        if header is None:raise ValueError('LinkedIn connection header not found')
        lines=lines[header:]
    reader=csv.DictReader(io.StringIO(''.join(lines)))
    return [{k:(v or '') for k,v in row.items() if k is not None} for row in reader if any(v for v in row.values())]

filename=sys.argv[1]
tables={};profile=[]
if zipfile.is_zipfile(filename):
    with zipfile.ZipFile(filename) as z:
        for name in z.namelist():
            base=os.path.basename(name).lower()
            if base not in ['connections.csv','messages.csv','profile.csv']:continue
            if z.getinfo(name).file_size>100*1024*1024:raise ValueError('Export table exceeds 100 MB')
            records=read_table(z.read(name).decode('utf-8-sig'),base=='connections.csv')
            tables[os.path.basename(name)]=records
else:
    with open(filename,encoding='utf-8-sig',newline='') as f:tables['Connections.csv']=read_table(f.read(),True)
if not tables.get('Connections.csv'):raise ValueError('Archive has no connection records')
json.dump(tables,sys.stdout,ensure_ascii=False)

"""Native Windows file-replacement probe; a gate, not application testing."""
import ctypes
from ctypes import wintypes as w
import hashlib,json,os
from pathlib import Path
import tempfile

k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
k.SetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_int,w.LPVOID,w.DWORD];k.SetFileInformationByHandle.restype=w.BOOL
k.MoveFileExW.argtypes=[w.LPCWSTR,w.LPCWSTR,w.DWORD];k.MoveFileExW.restype=w.BOOL
class RenameInfo(ctypes.Structure):
    _fields_=[('ReplaceIfExists',w.BOOLEAN),('RootDirectory',w.HANDLE),('FileNameLength',w.DWORD),('FileName',w.WCHAR*1024)]
def open_handle(path,access,share):
    h=k.CreateFileW(str(path),access,share,None,3,0,None)
    if h==w.HANDLE(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    return h
def rename(source,target):
    # Qt 6.9.3 QTemporaryFileEngine's Win32NonShared replacement path.
    h=open_handle(source,0x80000000|0x40000000|0x10000,0)
    try:
        value=RenameInfo();value.ReplaceIfExists=True;value.FileNameLength=len(str(target).encode('utf-16-le'));value.FileName=str(target)
        ok=bool(k.SetFileInformationByHandle(h,3,ctypes.byref(value),ctypes.sizeof(value)))
        return ok,0 if ok else ctypes.get_last_error()
    finally:k.CloseHandle(h)
result={'scope':__doc__,'sourceRevision':os.environ.get('GITHUB_SHA'),'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cases':[],'passed':False}
try:
    with tempfile.TemporaryDirectory(prefix='gc-atomic-probe-') as tmp:
        root=Path(tmp)
        for method in ['qt-native-rename','move-file-ex']:
            for share in [None,7,3]:
                source=root/'new.json';target=root/'target.json';source.write_bytes(b'{"new":true}');target.write_bytes(b'{"old":true}')
                reader=open_handle(target,0x80000000,share) if share is not None else None
                try:
                    if method=='qt-native-rename':ok,error=rename(source,target)
                    else:
                        ok=bool(k.MoveFileExW(str(source),str(target),1));error=0 if ok else ctypes.get_last_error()
                    content=target.read_bytes();assert content in [b'{"old":true}',b'{"new":true}'];assert content==(b'{"new":true}' if ok else b'{"old":true}')
                finally:
                    if reader is not None:k.CloseHandle(reader)
                entry={'method':method,'readerShareFlags':share,'replaced':ok,'win32Error':error,'completeJson':True}
                if not ok:
                    retry,retry_error=rename(source,target);entry.update(retryAfterReaderClose=retry,retryWin32Error=retry_error);assert retry
                result['cases'].append(entry)
    result['passed']=True
finally:
    report=Path(__file__).parent/'reports/windows-atomic-replace-gate';report.mkdir(parents=True,exist_ok=True)
    (report/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

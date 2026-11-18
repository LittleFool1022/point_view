/* 仅用于本机 Blender 验收：避免书签枚举阻塞于失联的 /tmp/fuse 挂载。
 * 不改挂载、不伪造模型文件；除该路径外完全转发 libc 调用。 */
#define _GNU_SOURCE
#define _LARGEFILE64_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
static int blocked(const char *p) { return !strncmp(p,"/tmp/fuse",9) && (p[9]=='/' || p[9]=='\0'); }
int stat(const char *p, struct stat *s) { if(blocked(p)){errno=ENOENT;return -1;} return ((int(*)(const char*,struct stat*))dlsym(RTLD_NEXT,"stat"))(p,s); }
int lstat(const char *p, struct stat *s) { if(blocked(p)){errno=ENOENT;return -1;} return ((int(*)(const char*,struct stat*))dlsym(RTLD_NEXT,"lstat"))(p,s); }
int stat64(const char *p, struct stat64 *s) { if(blocked(p)){errno=ENOENT;return -1;} return ((int(*)(const char*,struct stat64*))dlsym(RTLD_NEXT,"stat64"))(p,s); }
int __xstat(int v,const char *p,struct stat *s) { if(blocked(p)){errno=ENOENT;return -1;} return ((int(*)(int,const char*,struct stat*))dlsym(RTLD_NEXT,"__xstat"))(v,p,s); }
int __xstat64(int v,const char *p,struct stat64 *s) { if(blocked(p)){errno=ENOENT;return -1;} return ((int(*)(int,const char*,struct stat64*))dlsym(RTLD_NEXT,"__xstat64"))(v,p,s); }

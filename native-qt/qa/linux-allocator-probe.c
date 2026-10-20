// Opt-in diagnostic for the owned packaged publisher, never linked into the app.
// Build: cc -shared -fPIC -O2 -Wall -Wextra -Werror -pthread linux-allocator-probe.c -o probe.so
// mallinfo2 fields: https://sourceware.org/glibc/manual/latest/html_node/Statistics-of-Malloc.html
#define _GNU_SOURCE
#include <limits.h>
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static char command_path[PATH_MAX], report_path[PATH_MAX], temporary_path[PATH_MAX];
static unsigned long rss_kib(void) {
    unsigned long total=0, resident=0;
    FILE *file=fopen("/proc/self/statm", "r");
    if (file) { if(fscanf(file,"%lu %lu",&total,&resident)!=2) resident=0; fclose(file); }
    return resident*(unsigned long)sysconf(_SC_PAGESIZE)/1024;
}
static long long now_ns(void) {
    struct timespec now; clock_gettime(CLOCK_MONOTONIC,&now);
    return (long long)now.tv_sec*1000000000LL+now.tv_nsec;
}
static void snapshot(FILE *file, struct mallinfo2 value, unsigned long rss) {
    fprintf(file,"{\"allocatedBytes\":%zu,\"freeArenaBytes\":%zu,\"arenaBytes\":%zu,\"mmapBytes\":%zu,\"rssKiB\":%lu}",
        value.uordblks,value.fordblks,value.arena,value.hblkhd,rss);
}
static void *observe(void *unused) {
    (void)unused;
    for (;;) {
        struct timespec interval={0,50000000}; nanosleep(&interval,NULL);
        FILE *command=fopen(command_path,"r");
        if (!command) continue;
        unsigned sequence=0, trim=0;
        int fields=fscanf(command,"%u %u",&sequence,&trim);
        fclose(command); unlink(command_path);
        if(fields!=2 || trim>1) continue;
        struct mallinfo2 before=mallinfo2(); unsigned long before_rss=rss_kib();
        long long start=now_ns(); int changed=trim?malloc_trim(0):0;
        long long elapsed=now_ns()-start;
        struct mallinfo2 after=mallinfo2(); unsigned long after_rss=rss_kib();
        FILE *report=fopen(temporary_path,"w");
        if (!report) continue;
        fprintf(report,"{\"sequence\":%u,\"trimRequested\":%u,\"trimReleasedMemory\":%d,\"trimNanoseconds\":%lld,\"before\":",sequence,trim,changed,elapsed);
        snapshot(report,before,before_rss); fputs(",\"after\":",report); snapshot(report,after,after_rss); fputs("}\n",report);
        fclose(report); rename(temporary_path,report_path);
    }
    return NULL;
}
__attribute__((constructor)) static void initialize(void) {
    const char *target=getenv("GC_QA_HEAP_EXECUTABLE"), *command=getenv("GC_QA_HEAP_COMMAND"), *report=getenv("GC_QA_HEAP_REPORT");
    if (!target || !command || !report) return;
    char executable[PATH_MAX]; ssize_t size=readlink("/proc/self/exe",executable,sizeof(executable)-1);
    if(size<0) return;
    executable[size]='\0';
    // Output helpers inherit environment variables; observe only the publisher.
    if(strcmp(executable,target)!=0 || strlen(command)>=sizeof(command_path) || strlen(report)+5>=sizeof(report_path)) return;
    strcpy(command_path,command); strcpy(report_path,report);
    snprintf(temporary_path,sizeof(temporary_path),"%s.tmp",report);
    pthread_t thread;
    if(pthread_create(&thread,NULL,observe,NULL)==0) pthread_detach(thread);
}

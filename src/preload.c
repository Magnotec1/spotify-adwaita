#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <arpa/inet.h>

// -----------------------------------------------------------------------------
// 1. Forward original app_indicator symbols expected by Spotify Flatpak
// -----------------------------------------------------------------------------
typedef void* (*app_indicator_new_t)(const char*, const char*, int);
typedef void* (*app_indicator_new_with_path_t)(const char*, const char*, int, const char*);
typedef void (*app_indicator_set_icon_t)(void*, const char*);
typedef void (*app_indicator_set_icon_full_t)(void*, const char*, const char*);

static app_indicator_new_t orig_app_indicator_new = NULL;
static app_indicator_new_with_path_t orig_app_indicator_new_with_path = NULL;
static app_indicator_set_icon_t orig_app_indicator_set_icon = NULL;
static app_indicator_set_icon_full_t orig_app_indicator_set_icon_full = NULL;

typedef void* (*real_dlsym_t)(void*, const char*);
static real_dlsym_t real_dlsym = NULL;

static void init_real_dlsym(void) {
    if (!real_dlsym) {
        real_dlsym = (real_dlsym_t)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
    }
}

static pthread_once_t app_ind_once = PTHREAD_ONCE_INIT;

static void init_app_indicator(void) {
    init_real_dlsym();
    orig_app_indicator_new = (app_indicator_new_t)real_dlsym(RTLD_NEXT, "app_indicator_new");
    orig_app_indicator_new_with_path = (app_indicator_new_with_path_t)real_dlsym(RTLD_NEXT, "app_indicator_new_with_path");
    orig_app_indicator_set_icon = (app_indicator_set_icon_t)real_dlsym(RTLD_NEXT, "app_indicator_set_icon");
    orig_app_indicator_set_icon_full = (app_indicator_set_icon_full_t)real_dlsym(RTLD_NEXT, "app_indicator_set_icon_full");
}

void* app_indicator_new(const char* id, const char* icon_name, int category) {
    pthread_once(&app_ind_once, init_app_indicator);
    if (orig_app_indicator_new) return orig_app_indicator_new(id, "com.spotify.Client-symbolic", category);
    return NULL;
}

void* app_indicator_new_with_path(const char* id, const char* icon_name, int category, const char* icon_path) {
    pthread_once(&app_ind_once, init_app_indicator);
    if (orig_app_indicator_new_with_path) return orig_app_indicator_new_with_path(id, "com.spotify.Client-symbolic", category, icon_path);
    return NULL;
}

void app_indicator_set_icon(void* app_indicator, const char* icon_name) {
    pthread_once(&app_ind_once, init_app_indicator);
    if (orig_app_indicator_set_icon) orig_app_indicator_set_icon(app_indicator, "com.spotify.Client-symbolic");
}

void app_indicator_set_icon_full(void* app_indicator, const char* icon_name, const char* icon_desc) {
    pthread_once(&app_ind_once, init_app_indicator);
    if (orig_app_indicator_set_icon_full) orig_app_indicator_set_icon_full(app_indicator, "com.spotify.Client-symbolic", icon_desc);
}

// -----------------------------------------------------------------------------
// 2. Intercept socket connect for Wayland socket tracking
// -----------------------------------------------------------------------------
static int chromium_wayland_fd = -1;
static int (*real_connect)(int, const struct sockaddr*, socklen_t) = NULL;

int connect(int sockfd, const struct sockaddr* addr, socklen_t addrlen) {
    init_real_dlsym();
    if (!real_connect) {
        real_connect = (int (*)(int, const struct sockaddr*, socklen_t))real_dlsym(RTLD_NEXT, "connect");
    }
    if (addr && addr->sa_family == AF_UNIX) {
        const struct sockaddr_un* un = (const struct sockaddr_un*)addr;
        if (strstr(un->sun_path, "wayland")) {
            fprintf(stderr, "[spotify-adwaita][pid %d] Intercepted Wayland socket connect: fd=%d, path=%s\n",
                    getpid(), sockfd, un->sun_path);
            fflush(stderr);
            chromium_wayland_fd = sockfd;
        }
    }
    return real_connect ? real_connect(sockfd, addr, addrlen) : -1;
}

// -----------------------------------------------------------------------------
// 3. CEF Views Window & UI Thread Task Dispatch
// -----------------------------------------------------------------------------
typedef struct _cef_rect_t {
    int x;
    int y;
    int width;
    int height;
} cef_rect_t;

typedef struct _cef_draggable_region_t {
    cef_rect_t bounds;
    int draggable;
} cef_draggable_region_t;

typedef void (*set_draggable_regions_t)(void* window, size_t count, const cef_draggable_region_t* regions);
typedef int (*cef_post_task_t)(int thread_id, void* task);

static void* g_window = NULL;
static cef_post_task_t real_cef_post_task = NULL;

static void init_cef_post_task(void) {
    if (!real_cef_post_task) {
        init_real_dlsym();
        real_cef_post_task = (cef_post_task_t)real_dlsym(RTLD_DEFAULT, "cef_post_task");
    }
}

typedef struct {
    size_t size; // 0x30 required by CEF
    void (*add_ref)(void*);
    int (*release)(void*);
    int (*has_one_ref)(void*);
    int (*has_at_least_one_ref)(void*);
    void (*execute)(void*);
    // Task Payload
    size_t count;
    cef_draggable_region_t regions[64];
    int ref_count;
} my_drag_task_t;

static void task_add_ref(void* s) {
    my_drag_task_t* t = (my_drag_task_t*)s;
    __sync_add_and_fetch(&t->ref_count, 1);
}

static int task_release(void* s) {
    my_drag_task_t* t = (my_drag_task_t*)s;
    if (__sync_sub_and_fetch(&t->ref_count, 1) == 0) {
        free(t);
        return 1;
    }
    return 0;
}

static int task_has_one_ref(void* s) {
    my_drag_task_t* t = (my_drag_task_t*)s;
    return t->ref_count == 1;
}

static int task_has_at_least_one_ref(void* s) {
    my_drag_task_t* t = (my_drag_task_t*)s;
    return t->ref_count >= 1;
}

static void task_execute(void* s) {
    my_drag_task_t* t = (my_drag_task_t*)s;
    if (g_window) {
        set_draggable_regions_t set_drag = *(set_draggable_regions_t*)((char*)g_window + 0x320);
        if (set_drag) {
            set_drag(g_window, t->count, t->regions);
            fprintf(stderr, "[spotify-adwaita][pid %d] Draggable regions updated on UI thread: count=%zu\n",
                    getpid(), t->count);
            fflush(stderr);
        }
    }
}

static void post_draggable_regions(size_t count, const cef_draggable_region_t* regions) {
    init_cef_post_task();
    if (!real_cef_post_task) {
        // Fallback: direct call if on UI thread or post_task unavailable
        if (g_window) {
            set_draggable_regions_t set_drag = *(set_draggable_regions_t*)((char*)g_window + 0x320);
            if (set_drag) set_drag(g_window, count, regions);
        }
        return;
    }

    my_drag_task_t* task = (my_drag_task_t*)calloc(1, sizeof(my_drag_task_t));
    if (!task) return;

    task->size = 0x30;
    task->add_ref = task_add_ref;
    task->release = task_release;
    task->has_one_ref = task_has_one_ref;
    task->has_at_least_one_ref = task_has_at_least_one_ref;
    task->execute = task_execute;
    task->ref_count = 1;

    task->count = count > 64 ? 64 : count;
    memcpy(task->regions, regions, task->count * sizeof(cef_draggable_region_t));

    real_cef_post_task(0 /* TID_UI */, task);
}

static void (*orig_on_window_created)(void* self, void* window) = NULL;

static void my_on_window_created(void* self, void* window) {
    fprintf(stderr, "[spotify-adwaita][pid %d] on_window_created called! window=%p\n", getpid(), window);
    fflush(stderr);
    g_window = window;

    // Apply initial safe regions: top 64px draggable, but exclude buttons & inputs
    cef_draggable_region_t init_regions[4];
    // 1. Full header
    init_regions[0].bounds.x = 0;
    init_regions[0].bounds.y = 0;
    init_regions[0].bounds.width = 3000;
    init_regions[0].bounds.height = 64;
    init_regions[0].draggable = 1;

    // 2. Exclude left navigation buttons
    init_regions[1].bounds.x = 0;
    init_regions[1].bounds.y = 0;
    init_regions[1].bounds.width = 160;
    init_regions[1].bounds.height = 64;
    init_regions[1].draggable = 0;

    // 3. Exclude search area
    init_regions[2].bounds.x = 200;
    init_regions[2].bounds.y = 0;
    init_regions[2].bounds.width = 600;
    init_regions[2].bounds.height = 64;
    init_regions[2].draggable = 0;

    // 4. Exclude right controls (profile, close button)
    init_regions[3].bounds.x = 800;
    init_regions[3].bounds.y = 0;
    init_regions[3].bounds.width = 2200;
    init_regions[3].bounds.height = 64;
    init_regions[3].draggable = 0;

    set_draggable_regions_t set_drag = *(set_draggable_regions_t*)((char*)window + 0x320);
    if (set_drag) {
        set_drag(window, 4, init_regions);
        fprintf(stderr, "[spotify-adwaita][pid %d] Initial safe draggable regions applied\n", getpid());
        fflush(stderr);
    }

    if (orig_on_window_created) {
        orig_on_window_created(self, window);
    }
}

static int is_frameless_hook(void* self, void* window) {
    fprintf(stderr, "[spotify-adwaita][pid %d] is_frameless called -> RETURNING 1 (BORDERLESS)\n", getpid());
    fflush(stderr);
    return 1;
}

static int get_titlebar_height_hook(void* self, void* window, float* titlebar_height) {
    if (titlebar_height) {
        *titlebar_height = 64.0f;
    }
    return 1;
}

// -----------------------------------------------------------------------------
// 4. Command listener thread for close & dynamic regions
// -----------------------------------------------------------------------------
static void* window_cmd_server(void* arg) {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) return NULL;

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = htons(45454);

    if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        close(server_fd);
        return NULL;
    }

    if (listen(server_fd, 5) != 0) {
        close(server_fd);
        return NULL;
    }

    while (1) {
        int client = accept(server_fd, NULL, NULL);
        if (client < 0) continue;

        char buf[8192] = {0};
        ssize_t bytes = read(client, buf, sizeof(buf) - 1);
        if (bytes > 0) {
            if (strstr(buf, "/close")) {
                const char* resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\n\r\nOK";
                write(client, resp, strlen(resp));
                close(client);
                close(server_fd);
                _exit(0);
            } else if (strstr(buf, "/minimize") || strstr(buf, "/toggle_maximize")) {
                const char* resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\n\r\nOK";
                write(client, resp, strlen(resp));
                close(client);
                continue;
            } else if (strstr(buf, "/regions?r=")) {
                char* r_str = strstr(buf, "/regions?r=") + 11;
                char* end = strchr(r_str, ' ');
                if (end) *end = '\0';

                cef_draggable_region_t regions[64];
                size_t count = 0;

                char* saveptr = NULL;
                char* token = strtok_r(r_str, ";", &saveptr);
                while (token && count < 64) {
                    int x = 0, y = 0, w = 0, h = 0, d = 0;
                    if (sscanf(token, "%d,%d,%d,%d,%d", &x, &y, &w, &h, &d) == 5) {
                        regions[count].bounds.x = x;
                        regions[count].bounds.y = y;
                        regions[count].bounds.width = w;
                        regions[count].bounds.height = h;
                        regions[count].draggable = d;
                        count++;
                    }
                    token = strtok_r(NULL, ";", &saveptr);
                }

                if (count > 0) {
                    fprintf(stderr, "[spotify-adwaita][pid %d] Received /regions with count=%zu\n", getpid(), count);
                    fflush(stderr);
                    post_draggable_regions(count, regions);
                }

                const char* resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\n\r\nOK";
                write(client, resp, strlen(resp));
                close(client);
                continue;
            }
        }
        close(client);
    }
    return NULL;
}

// -----------------------------------------------------------------------------
// 5. Intercept cef_window_create_top_level
// -----------------------------------------------------------------------------
typedef void* (*cef_window_create_top_level_t)(void* delegate);

void* cef_window_create_top_level(void* delegate) {
    init_real_dlsym();
    static cef_window_create_top_level_t orig = NULL;
    if (!orig) {
        orig = (cef_window_create_top_level_t)real_dlsym(RTLD_NEXT, "cef_window_create_top_level");
    }

    fprintf(stderr, "[spotify-adwaita][pid %d] cef_window_create_top_level hooked! delegate=%p\n", getpid(), delegate);
    fflush(stderr);

    if (delegate) {
        uintptr_t* ptrs = (uintptr_t*)delegate;

        // Hook on_window_created (offset 0x80)
        orig_on_window_created = (void (*)(void*, void*))ptrs[0x80 / sizeof(uintptr_t)];
        ptrs[0x80 / sizeof(uintptr_t)] = (uintptr_t)my_on_window_created;

        // Hook is_frameless (offset 0xd0) -> force borderless
        ptrs[0xd0 / sizeof(uintptr_t)] = (uintptr_t)is_frameless_hook;

        // Hook get_titlebar_height (offset 0xe0) -> report 64px
        ptrs[0xe0 / sizeof(uintptr_t)] = (uintptr_t)get_titlebar_height_hook;
    }

    // Start local command server thread
    pthread_t thread;
    pthread_create(&thread, NULL, window_cmd_server, NULL);
    pthread_detach(thread);

    void* window = orig ? orig(delegate) : NULL;
    return window;
}

// -----------------------------------------------------------------------------
// 6. dlsym Interception
// -----------------------------------------------------------------------------
void* dlsym(void* handle, const char* name) {
    init_real_dlsym();
    if (name) {
        if (strcmp(name, "connect") == 0) return (void*)connect;
        if (strcmp(name, "cef_window_create_top_level") == 0) return (void*)cef_window_create_top_level;
    }
    return real_dlsym ? real_dlsym(handle, name) : NULL;
}

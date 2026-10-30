# Phiên & tab

**Phiên** là một cuộc trò chuyện với Claude trong một thư mục. Phiên chạy trong daemon, nên chúng vẫn tiếp tục khi bạn đóng trình duyệt.

## Cách bắt đầu một phiên {#how-to-start-a-session}

1. Bấm **Phiên mới** (hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>).
2. Chọn dự án, model, chế độ và effort trong hộp prompt.
3. Gõ prompt và nhấn <kbd>Enter</kbd>.

Để bắt đầu trong một dự án cụ thể, dùng nút **+** trên dòng dự án đó trong thanh bên.

Trên màn hình rộng (từ 1024px trở lên), tab Phiên mới đã hiện bảng bên và bảng dưới của dự án, nên không có gì dịch chuyển khi bạn gửi tin nhắn đầu tiên. Tệp, Graph và Terminal hoạt động như trong một phiên, còn Thay đổi hiện "Chưa có thay đổi". Chọn dự án khác trong hộp prompt sẽ chuyển các bảng sang dự án đó.

![Tab Phiên mới với bảng Thay đổi và một terminal](/screenshots/new-session.png)

## Cách tìm một phiên {#how-to-find-a-session}

- Gõ vào **Tìm phiên** ở đầu thanh bên. Nó khớp với tiêu đề, dự án và nhánh.
- Thêm `@project=my-app` để chỉ tìm trong một dự án.
- Để tìm trong nội dung tin nhắn, mở [bảng lệnh](/vi/features/palette) (<kbd>Ctrl</kbd>+<kbd>K</kbd>) và gõ.
- Gõ `/resume` trong hộp prompt để tìm các phiên của dự án hiện tại.

## Menu phiên {#session-menu}

Rê chuột lên dòng phiên và bấm `⋯`:

| Mục | Tác dụng |
| --- | --- |
| Đổi tên | Đổi tiêu đề. |
| Lưu trữ / Bỏ lưu trữ | Ẩn phiên khỏi danh sách mà không xóa. |
| Sao chép ID phiên | Sao chép ID. |
| Đóng tab | Đóng tab của phiên, khi tab đang mở. |
| Xóa… | Xóa vĩnh viễn phiên và lịch sử của nó (có hỏi trước). |

Cùng menu này mở bằng bấm chuột phải. Xem [Menu ngữ cảnh](/vi/features/context-menus).

## Tab {#tabs}

Bấm chuột phải vào tab để có **Đóng các tab khác**, **Ghim tab**, **Hiện trong thanh bên** và nhiều mục khác: [Menu ngữ cảnh](/vi/features/context-menus). Để hiện hai phiên cùng lúc, xem [Chia màn hình](/vi/features/split-view). Để đóng nhiều tab theo quy tắc, xem [Dọn dẹp](/vi/features/clean-up).

Mỗi phiên đang mở là một tab ở phía trên. Các tab được nhóm theo dự án, như nhóm tab của Chrome.

![Tab nhóm theo dự án: nhóm demo-shop đang mở, nhóm demo-api thu gọn thành chip](/screenshots/sessions.png)

| Để | Làm |
| --- | --- |
| Chuyển tab | Bấm vào tab, hoặc <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>8</kbd> (<kbd>⌃</kbd> <kbd>1</kbd>…<kbd>8</kbd> trên Mac). <kbd>Alt</kbd>+<kbd>9</kbd> chuyển đến tab cuối. |
| Đóng tab | Nút **×** của tab, hoặc <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>W</kbd> |
| Đóng cả nhóm | Bấm chuột giữa vào chip nhóm, hoặc bấm chuột phải vào chip › **Đóng nhóm** |
| Sắp xếp lại | Kéo tab hoặc chip nhóm |

Khi bật **Tab thu gọn**, mỗi nhóm chỉ hiện chip của nó: rê chuột hoặc bấm vào chip để chọn một tab của nhóm, và bấm chuột phải vào chip để dùng các thao tác nhóm ([Menu ngữ cảnh](/vi/features/context-menus#group-chips)).

Thêm phím tab khác (mở lại tab đã đóng, đóng nhóm): [Phím tắt](/vi/reference/shortcuts).

Trên điện thoại, chạm vào bộ chuyển tab để xem mọi tab. Vuốt một dòng sang trái để đóng. Vuốt lên hoặc xuống trên bộ chuyển để đến tab trước hoặc sau: tên tab đi theo ngón tay của bạn và dừng ở tab kế tiếp, hoặc bật trở lại.

## Cần biết {#good-to-know}

- `/clear` (hoặc `/reset`, `/new`) bắt đầu một phiên mới trong cùng tab và giữ lại những gì bạn đã gõ.
- **Đóng khi nhàn rỗi:** phiên không có tab nào hiển thị sẽ đóng tiến trình Claude sau 10 phút nhàn rỗi. Phiên vẫn nằm trong danh sách. Prompt tiếp theo sẽ tiếp tục nó. Đổi thời gian bằng [`CLAUDE_UI_IDLE_CLOSE_MINUTES`](/vi/reference/cli#environment-variables).
- Đổi cách nhóm tab (theo dự án, theo worktree, hoặc không nhóm) và bật **Tab thu gọn** trong [Cài đặt › Bố cục › Tab](/vi/reference/settings#tabs).
- Nhóm thanh bên **Worktree** và **Dự án** (cũng có trong menu tùy chọn thanh bên), và "Chỉ hiện phiên đang hoạt động", nằm trong [Cài đặt › Bố cục › Thanh bên](/vi/reference/settings#sidebar).

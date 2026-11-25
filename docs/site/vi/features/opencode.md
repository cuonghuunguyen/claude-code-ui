# Engine OpenCode

Một phiên có thể chạy trên [OpenCode](https://opencode.ai) thay cho Claude. Ô prompt, dòng thời gian, quyền, tua lại và phần còn lại của ứng dụng hoạt động như nhau.

![Tab phiên mới với engine OpenCode và bộ chọn model đang mở](/screenshots/opencode.png)

## Cách dùng {#how-to-use}

1. Cài OpenCode (phiên bản 1.18.0 trở lên; OpenCode 1 và OpenCode 2 đều chạy được, claude-ui chọn adapter theo phiên bản binary) sao cho `opencode` nằm trong PATH của máy chạy daemon. Nếu không, đặt đường dẫn trong [Cài đặt › OpenCode](../reference/settings#opencode).
2. Ở tab phiên mới, chọn **OpenCode** trong chip **Engine**, chip đầu tiên của hàng. Engine không đổi được sau đó. Dòng trong thanh bên và đầu phiên hiện thẻ OpenCode.
3. Kết nối nhà cung cấp: Cài đặt › OpenCode › **Nhà cung cấp** › **Kết nối**, rồi nhập API key, hoặc đăng nhập trên trang của nhà cung cấp trong trình duyệt. Các model miễn phí của OpenCode chạy được khi chưa kết nối nhà cung cấp.
4. Chọn model trong bộ chọn model. Bộ chọn liệt kê mọi model OpenCode chạy được, nhóm theo nhà cung cấp. Từ 8 model trở lên có ô tìm kiếm (tên, id, nhà cung cấp). Nếu lấy danh sách lỗi, chân bộ chọn báo và có nút **Thử lại**. **Kết nối nhà cung cấp…** ở chân mở Cài đặt.
5. Chọn **agent** (Build, Plan hoặc agent tùy chỉnh trong cấu hình OpenCode của bạn) trong bộ chọn cạnh bộ chọn quyền. <kbd>Shift</kbd>+<kbd>Tab</kbd> chuyển lần lượt các agent.
6. Chọn chế độ quyền. **Theo cấu hình OpenCode** là mặc định: mặc định của OpenCode, mục `permission` của `opencode.json` và agent quyết định, claude-ui không thêm quy tắc. **Hỏi trước khi sửa**, **Tự động sửa** và, khi được bật, **Bỏ qua quyền** thêm quy tắc của claude-ui lên trên. Các từ chối của agent tùy chỉnh luôn thắng.

## Cần biết {#good-to-know}

- Hoạt động như với Claude: prompt, điều hướng lượt đang chạy, câu hỏi, yêu cầu quyền, [Tua lại](timeline#rewind), [Aside](aside), lệnh slash (`/compact`, `/undo`, `/redo`, `/clear` và các lệnh trong cấu hình OpenCode), [hình minh họa](visualize) và [điều phối](orchestration). Coordinator và từng worker tự chọn engine.
- Không có: vòng mức dùng gói và bộ chuyển tài khoản (thuộc về Claude), Reload plugins. Điều khiển mà phiên OpenCode không dùng được bị ẩn hoặc vô hiệu hóa, kèm tooltip "Engine của phiên này không hỗ trợ".
- Tua lại khôi phục tệp và cuộc trò chuyện cùng lúc; OpenCode không có chế độ chỉ một trong hai. Thay đổi tệp do OpenCode thực hiện hiện trong [Lịch sử cục bộ](timeline#local-history-file-timeline) cùng nội dung trước khi sửa.
- Hộp thoại MCP servers, Skills và Plugins sửa `opencode.json` của dự án, và Shells liệt kê các lệnh nền. Hộp thoại MCP còn có phạm vi **User** (`~/.config/opencode/opencode.json`): thêm và xóa máy chủ ở đó; hộp thoại Plugins gỡ plugin của cấu hình user, sau một bước xác nhận. Sau thay đổi như vậy OpenCode 1 khởi động lại server khi không có lượt, đăng nhập nhà cung cấp hay tạo phiên nào đang chạy. Agent OpenCode có thể bắt đầu [Fork](fork-subagents) và [inline task](inline-tasks).
- `/clear`, `/new` và `/reset` bắt đầu một phiên OpenCode mới trong cùng tab, giữ model, agent, chế độ quyền và effort của phiên cũ. Phiên cũ vẫn nằm trong danh sách. Lệnh bị từ chối khi một lượt đang chạy.
- Thẻ subagent hiện các bước của subagent (OpenCode 2) và các yêu cầu quyền của nó; **Stop agent** ngắt subagent. Các lệnh nền của nó hiện trong Shells (OpenCode 2). Các bước của inline task còn nguyên sau khi tải lại.
- Với OpenCode 2, danh sách việc cần làm hiện trong todo dock. Biểu mẫu câu hỏi của OpenCode 2 có các trường có kiểu (ngày, ngày giờ, email, URL, số, khoảng giá trị) và **Gửi** bị chặn đến khi giá trị hợp lệ.
- Gõ `@` trong ô prompt để liệt kê các subagent (ví dụ `explore`) phía trên danh sách tệp. Subagent được nhắc đến sẽ nhận việc; agent của phiên không đổi.
- Khi OpenCode thử lại với model đang bận hoặc bị giới hạn tốc độ, cuối lượt hiện lý do và "Retrying in 12s · attempt 2" thay cho Thinking. Khi OpenCode 1 kèm một liên kết với lý do, dòng đó hiện liên kết.
- Sau khi dừng vì giới hạn mức dùng hoặc tốc độ của nhà cung cấp, phiên tự tiếp tục khi giới hạn đặt lại, tối đa 3 lần thử. Tin nhắn của bạn đặt lại bộ đếm.
- Lượt mà OpenCode tự kết thúc hiện cảnh báo kèm lý do.
- OpenCode giữ lịch sử và thông tin đăng nhập nhà cung cấp của các phiên; claude-ui không giữ cái nào. Daemon khởi động một `opencode serve` khi có phiên OpenCode đầu tiên. Nó chỉ lắng nghe trên `127.0.0.1`, sau một mật khẩu ngẫu nhiên.
- [Môi trường](wsl-docker) (side) chạy OpenCode riêng (PATH của nó, hoặc cài đặt đường dẫn riêng). Cài đặt › OpenCode chỉ sửa daemon cục bộ.
- Cài đặt › OpenCode › **Khởi động lại OpenCode** bị từ chối khi có phiên OpenCode đang chạy.

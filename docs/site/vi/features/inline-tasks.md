# Tác vụ nội tuyến {#inline-tasks}

Tác vụ nội tuyến (inline task) là một công việc cỡ vừa mà Claude chạy ngay trong một lần gọi tool. Một model nhỏ với ngữ cảnh tối thiểu làm việc bằng các tool được cấp và chỉ trả về kết quả. Ngữ cảnh của phiên chỉ tăng thêm đúng phần kết quả, không tăng theo từng đầu ra trung gian.

Tác vụ nội tuyến không phải là một phiên: nó không có mục trong danh sách phiên và không có transcript riêng. Nó hiện dưới dạng một thẻ ngay dưới lần gọi tool `inline_task`.

## Khi nào dùng {#when-to-use}

Agent đọc các quy tắc sau (cùng một văn bản với hướng dẫn của agent):

> Use inline_task when the task:
> - needs 3-10 tool calls and only the result matters;
> - needs no parent conversation context beyond what fits in prompt + files;
> - is mechanical: run, extract, summarize, classify, format, small edit.
>
> Use a subagent instead when the task needs judgment or design, long exploration, parallel runs, or parent context.
> Do it directly when 1-2 tool calls suffice, or when the next step needs the raw output.
>
> Grant the least: tools default to Read, Grep, Glob; add Bash, Write, Edit or an MCP server only when needed.

Tóm tắt: dùng khi cần 3-10 lần gọi tool và chỉ cần kết quả; việc mang tính cơ học; không cần ngữ cảnh hội thoại. Dùng subagent khi cần phán đoán, thiết kế, khám phá dài, chạy song song hoặc ngữ cảnh của phiên. Tự làm trực tiếp khi 1-2 lần gọi tool là đủ, hoặc khi bước tiếp theo cần đầu ra thô.

## Các tình huống {#scenarios}

| Tình huống | Tác vụ nội tuyến làm | Trả về |
| --- | --- | --- |
| Thiết lập môi trường | Nhiều lệnh Bash: cài dependency, tạo config, khởi động service, kiểm tra port | Xong hoặc lỗi, kèm đầu ra của bước lỗi |
| Điều khiển Playwright (MCP hoặc CLI) | Mở trang, bấm qua các bước, chụp màn hình | Pass hoặc fail theo từng bước, đường dẫn ảnh chụp |
| Trích xuất log | grep và đọc log lớn, đối chiếu mốc thời gian | Các dòng hoặc giá trị được hỏi |
| Phân tích CI lỗi | Lấy log CI (Jenkins, GitHub Actions), tìm lỗi đầu tiên | Test lỗi, thông báo lỗi, file:line |
| Chạy test | Chạy bộ test, phân tích đầu ra | Chỉ các test lỗi, kèm thông báo |
| Quét trước khi push | Đọc `git diff origin/<base>...HEAD`, kiểm tra các dòng thêm vào: hostname, tên người, token, đường dẫn home | Kết quả kèm file:line, hoặc sạch |
| Việc vặt với git | Viết lại thời gian commit, cherry-pick, viết commit message từ diff | Kết quả và SHA mới |
| Lấy thông tin tracker | `gh issue view` kèm bình luận và PR liên quan | Tóm tắt ngắn trạng thái ticket |
| Tra cứu tài liệu | Truy vấn Context7 hoặc tài liệu web | Chữ ký API hoặc đoạn config chính xác |
| Tìm vị trí trong code | Grep và Glob trên repo để tìm nơi gọi một symbol | Danh sách file:line |
| Sửa cơ học | Đổi tên trong vài tệp, cập nhật import, chạy lint autofix, cập nhật snapshot | Các tệp đã đổi và kết quả kiểm tra |
| Kiểm tra giấy phép | Đọc metadata của dependency và LICENSE | Giấy phép và ghi chú tuân thủ |
| Chuyển đổi dữ liệu | Phân tích đầu ra JSON, YAML hoặc CSV thành dạng người gọi cần | Dữ liệu đã chuyển đổi |
| Trạng thái worker | Đọc transcript của một worker [điều phối](orchestration) | Trạng thái và câu hỏi đang mở |

## Thẻ tác vụ {#the-card}

Thẻ nằm dưới lần gọi tool. Thẻ hiển thị trạng thái, nội dung tác vụ và `model · lượt · token`. Khi tác vụ đang chạy, **Stop** hủy tác vụ; kết quả khi đó trả về với trạng thái stopped, kèm phần đã làm.

- **Các bước** (những tool tác vụ đã gọi) được thu gọn. Mở ra để theo dõi công việc.
- **Kết quả** hiển thị dạng văn bản, kèm danh sách tệp đã đổi.
- Yêu cầu quyền của tác vụ hiện trong phiên như mọi yêu cầu khác, và thẻ tự mở ra. Xem [Quyền và chế độ](permissions).

## Tác vụ được dùng gì {#what-it-can-use}

- Tool: mặc định `Read`, `Grep`, `Glob`. `Bash`, `Write`, `Edit` và các MCP server của phiên (ví dụ Playwright) chỉ khi agent cấp.
- Quyền: chế độ và quy tắc của phiên áp dụng cho mọi lần gọi tool. Tác vụ không bao giờ có nhiều quyền hơn phiên.
- Không hook, không CLAUDE.md, không memory, không skill. Hook PreToolUse và các hook khác của phiên cha không chạy bên trong tác vụ inline. Tác vụ không khởi động agent khác, và không có tool của claude-ui hay orchestration.
- Tài khoản: giống phiên (gói đăng ký hoặc API key). Không có key riêng.

## Giới hạn {#limits}

| Giới hạn | Giá trị |
| --- | --- |
| Lượt | Mặc định 10, tối đa 30 |
| Token đầu ra | 16.000 |
| Thời gian | 10 phút |
| Chạy cùng lúc | 3 mỗi phiên |
| Prompt | 20.000 ký tự |
| Tệp đưa cho tác vụ | 20 tệp, mỗi tệp 64 KB, tổng 256 KB |

Khi chạm giới hạn, tác vụ dừng và trả về kết quả một phần cùng lý do (lượt, token hoặc thời gian).

## Cài đặt {#settings}

Trong **Cài đặt › Phiên › Tác vụ nội tuyến**:

| Cài đặt | Mặc định | Ý nghĩa |
| --- | --- | --- |
| Bật | Bật | Tắt: các lượt bắt đầu sau đó không có tool `inline_task` |
| Model | `haiku` | Model cho phiên Claude Code |
| Model OpenCode | trống | `provider/model` cho phiên OpenCode. Trống: `small_model` của OpenCode, nếu không có thì model của phiên |
| Số lượt tối đa | 10 | Giới hạn lượt mặc định, từ 1 đến 30 |

## Cần biết {#good-to-know}

- Các bước chỉ được giữ khi daemon còn chạy. Sau khi khởi động lại hoặc tải lại, thẻ hiển thị kết quả, model, lượt, token và tệp, kèm ghi chú "Steps are not kept after the daemon restarts."
- Rewind code của phiên không hoàn tác các tệp mà tác vụ nội tuyến đã sửa.
- Danh sách tệp đã đổi lấy từ các bước Edit, Write và từ `git status`. Tệp đã bị sửa trước khi chạy tác vụ và chỉ bị lệnh Bash sửa tiếp thì không được liệt kê. Ngoài repo git chỉ tính các bước Edit và Write.

## Phiên OpenCode {#opencode-sessions}

Tác vụ nội tuyến hoạt động trong phiên OpenCode, với các hạn chế:

- OpenCode giữ prompt gốc và `AGENTS.md`, nên ngữ cảnh chỉ nhỏ hơn về tool và lịch sử, không nhỏ hơn về chỉ dẫn.
- Giới hạn lượt được áp dụng bằng cách dừng tác vụ sau lượt, không phải do model.
- Nếu không ghép được lần gọi với lần gọi đang chạy, tác vụ vẫn chạy và trả kết quả, nhưng thẻ không có các bước.

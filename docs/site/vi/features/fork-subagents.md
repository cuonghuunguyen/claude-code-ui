# Subagent dạng fork {#fork-subagents}

Fork là một subagent bắt đầu với bản sao toàn bộ cuộc trò chuyện của bạn. Nó chạy trong ngữ cảnh riêng và chỉ trả về kết quả. Các lần tìm kiếm, đọc tệp và log mà nó đi qua không vào ngữ cảnh của phiên, nên phiên dài vẫn gọn.

Fork không phải là một phiên mới và không phải là [aside](aside). Nó hiện dưới dạng thẻ **Fork** trong transcript, ngay dưới lần gọi của agent.

Fork hoạt động trong phiên Claude Code. OpenCode không có fork: subagent của OpenCode luôn bắt đầu mới, với bản mô tả do agent viết.

## Khi nào fork {#when-to-fork}

Agent đọc các quy tắc sau (cùng một văn bản với hướng dẫn của agent):

> Fork when the work:
> - needs many reads, searches or logs and only the conclusion matters;
> - is independent of your next step and can run in parallel;
> - needs this conversation's decisions or file knowledge, so a fresh agent would need a long brief;
> - would take more than ~5 file reads or return large output.
>
> Do not fork when the task:
> - is one small step (one read, one edit);
> - feeds a next step that needs the raw output;
> - edits files the main thread also edits;
> - fits a short, self-contained brief: use a fresh subagent and set `model` explicitly (cheaper).

Tóm tắt: fork khi cần đọc, tìm kiếm hoặc xem log nhiều mà chỉ cần kết luận; việc độc lập với bước kế tiếp; việc cần quyết định và kiến thức về tệp của cuộc trò chuyện; hoặc dự kiến hơn khoảng 5 lần đọc tệp hay đầu ra lớn. Không fork khi việc chỉ là một bước nhỏ; bước kế tiếp cần đầu ra thô; việc sửa tệp mà luồng chính cũng sửa; hoặc một bản mô tả ngắn, tự đủ là được (dùng subagent mới và đặt `model` rõ ràng, rẻ hơn).

Agent tự quyết định khi nào fork. Không có fork tự động khi ngữ cảnh vượt một ngưỡng.

## Thẻ Fork {#the-card}

Thẻ hiện **Fork**, tác vụ, trạng thái và thời gian chạy. Khi đang chạy, **Stop** hủy nó.

- **Các bước** (lần gọi tool của fork) được thu gọn sau một số đếm. Mở ra để theo dõi công việc.
- **Kết quả** là câu trả lời cuối của fork. Nó hiện khi lần chạy đã kết thúc.
- **Open** mở fork trong chế độ xem subagent, như mọi subagent khác.

Sau khi khởi động lại daemon hoặc tải lại, thẻ được khôi phục cùng các bước và kết quả.

## Fork dùng gì {#what-a-fork-uses}

- Model, chế độ quyền và quy tắc của phiên. Fork trên model lớn tốn token của model đó. Nó dùng chung prompt cache của phiên.
- Nó chạy nền. Agent nhận kết quả trong một thông báo khi fork kết thúc.
- Nó không khởi động agent khác.

## Cài đặt {#settings}

Trong **Settings › Sessions › Fork subagents**:

| Cài đặt | Mặc định | Ý nghĩa |
| --- | --- | --- |
| Cho agent tự fork | Bật | Tắt: các lượt bắt đầu sau đó không fork được, và agent không nhận hướng dẫn về fork |

Cài đặt áp dụng cho lượt bắt đầu sau khi đổi. Không áp dụng cho phiên OpenCode.

## Cần biết {#good-to-know}

- Fork kế thừa cuộc trò chuyện đến lúc nó bắt đầu. Việc bạn thêm sau đó nó không thấy.
- Hai fork sửa cùng tệp có thể xung đột. Hướng dẫn bảo agent không fork việc sửa tệp mà luồng chính cũng sửa.
- Khi một bản mô tả ngắn, tự đủ là được, subagent thường rẻ hơn: agent có thể chọn model nhỏ hơn cho nó.

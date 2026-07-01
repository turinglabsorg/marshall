package coordinator

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type redisValue struct {
	kind  byte
	str   string
	num   int64
	items []redisValue
	nil   bool
}

type redisClient struct {
	addr    string
	timeout time.Duration
}

func newRedisClient(addr string) *redisClient {
	return &redisClient{addr: addr, timeout: 5 * time.Second}
}

func (client *redisClient) command(ctx context.Context, args ...string) (redisValue, error) {
	values, err := client.commands(ctx, args)
	if err != nil {
		return redisValue{}, err
	}
	if len(values) != 1 {
		return redisValue{}, fmt.Errorf("unexpected Redis response count")
	}
	return values[0], nil
}

func (client *redisClient) commands(ctx context.Context, argsList ...[]string) ([]redisValue, error) {
	if len(argsList) == 0 {
		return []redisValue{}, nil
	}
	dialer := net.Dialer{Timeout: client.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", client.addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(client.timeout))
	}

	var payload []byte
	for _, args := range argsList {
		payload = append(payload, encodeRESP(args)...)
	}
	if _, err := conn.Write(payload); err != nil {
		return nil, err
	}

	reader := bufio.NewReader(conn)
	values := make([]redisValue, 0, len(argsList))
	for range argsList {
		value, err := readRESP(reader)
		if err != nil {
			return nil, err
		}
		if value.kind == '-' {
			return nil, errors.New(value.str)
		}
		values = append(values, value)
	}
	return values, nil
}

func encodeRESP(args []string) []byte {
	var builder strings.Builder
	builder.WriteString("*")
	builder.WriteString(strconv.Itoa(len(args)))
	builder.WriteString("\r\n")
	for _, arg := range args {
		builder.WriteString("$")
		builder.WriteString(strconv.Itoa(len(arg)))
		builder.WriteString("\r\n")
		builder.WriteString(arg)
		builder.WriteString("\r\n")
	}
	return []byte(builder.String())
}

func readRESP(reader *bufio.Reader) (redisValue, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return redisValue{}, err
	}

	switch prefix {
	case '+', '-':
		line, err := readLine(reader)
		return redisValue{kind: prefix, str: line}, err
	case ':':
		line, err := readLine(reader)
		if err != nil {
			return redisValue{}, err
		}
		num, err := strconv.ParseInt(line, 10, 64)
		if err != nil {
			return redisValue{}, err
		}
		return redisValue{kind: prefix, num: num}, nil
	case '$':
		line, err := readLine(reader)
		if err != nil {
			return redisValue{}, err
		}
		length, err := strconv.Atoi(line)
		if err != nil {
			return redisValue{}, err
		}
		if length == -1 {
			return redisValue{kind: prefix, nil: true}, nil
		}
		buffer := make([]byte, length+2)
		if _, err := io.ReadFull(reader, buffer); err != nil {
			return redisValue{}, err
		}
		if string(buffer[length:]) != "\r\n" {
			return redisValue{}, fmt.Errorf("invalid bulk string terminator")
		}
		return redisValue{kind: prefix, str: string(buffer[:length])}, nil
	case '*':
		line, err := readLine(reader)
		if err != nil {
			return redisValue{}, err
		}
		length, err := strconv.Atoi(line)
		if err != nil {
			return redisValue{}, err
		}
		if length == -1 {
			return redisValue{kind: prefix, nil: true}, nil
		}
		items := make([]redisValue, 0, length)
		for range length {
			item, err := readRESP(reader)
			if err != nil {
				return redisValue{}, err
			}
			items = append(items, item)
		}
		return redisValue{kind: prefix, items: items}, nil
	default:
		return redisValue{}, fmt.Errorf("unsupported RESP prefix %q", prefix)
	}
}

func readLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(line, "\r\n") {
		return "", fmt.Errorf("invalid RESP line terminator")
	}
	return strings.TrimSuffix(line, "\r\n"), nil
}

func (value redisValue) stringValue() string {
	if value.kind == ':' {
		return strconv.FormatInt(value.num, 10)
	}
	return value.str
}

# A pseudo-terminal standing in for a Herdr pane (100x30 cells of 9x20 px).
# Prints the pane shell's pid, then echoes everything written to the pane's terminal.
import fcntl, os, pty, struct, subprocess, sys, termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('4H', 30, 100, 900, 600))
shell = subprocess.Popen(['sleep', '600'], stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                         preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
os.close(slave)
sys.stdout.write(f'{shell.pid}\n')
sys.stdout.flush()
try:
    while data := os.read(master, 65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
except OSError:
    pass
finally:
    shell.kill()
